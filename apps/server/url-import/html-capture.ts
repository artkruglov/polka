import {createHash} from 'node:crypto';
import {parse,serialize,type DefaultTreeAdapterTypes as Tree} from 'parse5';
import postcss from 'postcss';
import {canonicalizeManifest} from '../../../packages/contracts/bundle.ts';
import {MAX_BYTES} from '../../../packages/contracts/index.ts';
import {buildInlineBundle} from '../bundle-inline.ts';
import {fetchPublic,publicUrl,type PublicResponse} from './public-fetch.ts';

type Fetcher=(url:string,options:{maxBytes:number;signal:AbortSignal})=>Promise<PublicResponse>;
export class HtmlCaptureError extends Error {constructor(public code:string,message:string){super(message);}}
const extensions:Record<string,string>={'text/html':'html','text/css':'css','text/javascript':'js','application/javascript':'js','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/svg+xml':'svg','font/woff2':'woff2'};
/** Produces a bundle, never executes source JavaScript and never saves/publishes it.
 * All dependency requests use the same public-fetch boundary as the entrypoint.
 */
export async function captureHtmlUrl(input:string,{fetcher=fetchPublic,signal}:{fetcher?:Fetcher;signal?:AbortSignal}={}) {
 const timeout=AbortSignal.timeout(45_000);const abort=signal?AbortSignal.any([signal,timeout]):timeout;
 const sourceUrl=publicUrl(input);
 if(['claude.ai','chatgpt.com','chat.openai.com'].includes(sourceUrl.hostname.replace(/^www\./,'')))throw new HtmlCaptureError('provider_adapter_required','Для этой ссылки нужен адаптер извлечения артефакта. Оболочка чата не будет сохранена вместо результата.');
 const stored=new Map<string,{mime:string;bytes:Buffer}>();const paths=new Map<string,string>();let downloaded=0;let sequence=0;
 const request=async(url:string)=>{abort.throwIfAborted();const r=await fetcher(url,{maxBytes:MAX_BYTES-downloaded,signal:abort});downloaded+=r.bytes.length;if(downloaded>MAX_BYTES)throw new HtmlCaptureError('too_large','Страница с ресурсами превышает 5 МиБ.');return r;};
 const main=await request(sourceUrl.href);
 if(!/^text\/html(?:;|$)/i.test(main.contentType))throw new HtmlCaptureError('unsupported_type','Ожидалась HTML-страница.');
 if(['claude.ai','chatgpt.com','chat.openai.com'].includes(new URL(main.url).hostname.replace(/^www\./,'')))throw new HtmlCaptureError('provider_adapter_required','Источник перенаправил на провайдерскую оболочку, нужен отдельный адаптер.');
 const html=main.bytes.toString('utf8');if(!Buffer.from(html).equals(main.bytes))throw new HtmlCaptureError('unsupported_encoding','Пока поддерживается только UTF-8.');
 const doc=parse(html);const nodes:Tree.Element[]=[];
 function walk(n:Tree.Node){if('tagName'in n)nodes.push(n);if('childNodes'in n)for(const c of n.childNodes)walk(c);if('content'in n)walk(n.content);}
 walk(doc);
 let base=main.url;const baseNode=nodes.find(n=>n.tagName==='base');const baseHref=baseNode?.attrs.find(a=>a.name==='href')?.value;if(baseHref)base=publicUrl(new URL(baseHref,base).href).href;
 const warnings=new Set<string>();
 async function resource(value:string,parent:string):Promise<string>{
  if(!value||value.startsWith('#')||value.startsWith('data:'))return value;
  const url=publicUrl(new URL(value,parent).href);const fragment=new URL(value,parent).hash;
  const cached=paths.get(url.href);if(cached)return cached+fragment;
  if(paths.size>=63)throw new HtmlCaptureError('too_many_files','У страницы слишком много ресурсов.');
  // Reserve the URL before traversing CSS so cycles cannot cause unbounded requests.
  const key=`asset-${++sequence}`;paths.set(url.href,key);
  const response=await request(url.href);const originalMime=response.contentType.split(';')[0].trim().toLowerCase();const extension=extensions[originalMime];
  if(!extension||originalMime==='text/html')throw new HtmlCaptureError('unsupported_asset','Ресурс страницы имеет неподдерживаемый формат.');
  // Extension is not needed by the bundle contract; stable paths also handle CSS cycles.
  const mime=originalMime==='application/javascript'?'text/javascript':originalMime;
  let bytes=response.bytes;
  if(mime==='text/css')bytes=Buffer.from(await css(bytes.toString('utf8'),response.url));
  stored.set(key,{mime,bytes});return key+fragment;
 }
 async function css(value:string,parent:string){
  const tree=postcss.parse(value);const declarations:postcss.Declaration[]=[];const imports:postcss.AtRule[]=[];
  tree.walkDecls(d=>{declarations.push(d);});tree.walkAtRules('import',r=>{imports.push(r);});
  for(const r of imports){const match=r.params.match(/^(?:url\(\s*)?["']([^"']+)["']\s*\)?(.*)$/s);if(!match)throw new HtmlCaptureError('unsupported_css','Не удалось разобрать CSS import.');r.params=`url("${await resource(match[1],parent)}")${match[2]}`;}
  for(const d of declarations){
   if(/url\(/i.test(d.value)&&/\\/.test(d.value))throw new HtmlCaptureError('unsupported_css','CSS URL с escape-последовательностью пока не поддерживается.');
   const matches=[...d.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)];
   let next=d.value;for(const m of matches){const path=await resource(m[1]??m[2]??m[3],parent);next=next.replace(m[0],()=>`url("${path}")`);}d.value=next;
  }return tree.toString();
 }
 for(const node of nodes){
  if(node.tagName==='base'){if(node.parentNode&&'childNodes'in node.parentNode)node.parentNode.childNodes=node.parentNode.childNodes.filter(n=>n!==node);continue;}
  if(node.tagName==='iframe'||node.tagName==='object'||node.tagName==='embed')warnings.add('Встроенный внешний документ требует отдельного импорта.');
  node.attrs=node.attrs.filter(a=>a.name!=='integrity');
  for(const a of node.attrs){
   if(a.name==='style')a.value=await css(a.value,base);
   if(a.name==='srcset')warnings.add('Адаптивные изображения srcset ещё не локализованы.');
   if((a.name==='src'&&['script','img','source','video','audio'].includes(node.tagName))||(a.name==='poster'&&node.tagName==='video')||(a.name==='href'&&node.tagName==='link'&&node.attrs.some(x=>x.name==='rel'&&x.value.split(/\s+/).some(v=>['stylesheet','icon'].includes(v)))))a.value=await resource(a.value,base);
  }
  if(node.tagName==='style')for(const child of node.childNodes)if(child.nodeName==='#text') (child as Tree.TextNode).value=await css((child as Tree.TextNode).value,base);
 }
 // This is a conservative compatibility diagnostic, not a security boundary or
 // proof that arbitrary JavaScript is offline. The viewer CSP remains authoritative.
 const scripts = [
  ...nodes.filter(n=>n.tagName==='script').flatMap(n=>n.childNodes.filter((c):c is Tree.TextNode=>c.nodeName==='#text').map(c=>c.value)),
  ...nodes.flatMap(n=>n.attrs.filter(a=>a.name.startsWith('on')).map(a=>a.value)),
  ...[...stored.values()].filter(f=>f.mime==='text/javascript').map(f=>f.bytes.toString('utf8')),
 ];
 if(scripts.some(script=>/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b|\bimport\s*\(/.test(script)))
  warnings.add('В коде найдены возможные сетевые зависимости. Внешние API и динамическая загрузка в просмотре отключены; связанные действия могут не работать.');
 const output=Buffer.from(serialize(doc));stored.set('index.html',{mime:'text/html',bytes:output});
 const safeSource=new URL(main.url);safeSource.search='';safeSource.hash='';
 const manifest=canonicalizeManifest({version:1,entrypoint:'index.html',runtime:'preserved-only-v1',files:[...stored].map(([path,{mime,bytes}])=>({path,mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})),provenance:{kind:'url',sourceUrl:safeSource.href,capturedAt:new Date().toISOString(),attribution:'Imported from a public URL by the user',license:'unknown'},dependencies:{status:'unknown',unresolved:[]}});
 const built=buildInlineBundle(manifest,new Map([...stored].map(([p,f])=>[p,f.bytes])));
 if(!built.ok)warnings.add(`Интерактивная сборка недоступна: ${built.reason}`);
 // Successful localization alone cannot prove arbitrary JavaScript is offline.
 const title=nodes.find(n=>n.tagName==='title')?.childNodes.filter((n):n is Tree.TextNode=>n.nodeName==='#text').map(n=>n.value).join('').trim().slice(0,200)||sourceUrl.hostname;
 return {title,manifest,files:[...stored].map(([path,{bytes}])=>({path,encoding:'base64' as const,data:bytes.toString('base64')})),previewReady:built.ok&&warnings.size===0,warnings:[...warnings]};
}
