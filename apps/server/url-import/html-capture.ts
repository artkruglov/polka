import {createHash} from 'node:crypto';
import {parse,serialize,type DefaultTreeAdapterTypes as Tree} from 'parse5';
import postcss from 'postcss';
import {canonicalizeManifest} from '../../../packages/contracts/bundle.ts';
import {MAX_BYTES,MAX_TITLE} from '../../../packages/contracts/index.ts';
import {checkBuildInWorker} from '../bundle-derivatives.ts';
import {classifyHtmlBounded} from '../html.ts';
import {cdnRole} from '../react-runtime.ts';
import {matchLink} from '../../../packages/contracts/link-providers.ts';
import {fetchPublic,publicUrl,type PublicResponse} from './public-fetch.ts';

const downloadable=(url:URL)=>{const route=matchLink(url)?.route;return !route||route==='html'||route==='server-render';};
export type Fetcher=(url:string,options:{maxBytes:number;signal:AbortSignal})=>Promise<PublicResponse>;
const detach=(node:Tree.Element)=>{if(node.parentNode&&'childNodes'in node.parentNode)node.parentNode.childNodes=node.parentNode.childNodes.filter(n=>n!==node);};
/** One self-contained page: stylesheets become <style>, local images and fonts data: URIs; other files leave the bundle. */
function inlineInto(nodes:Tree.Element[],stored:Map<string,{mime:string;bytes:Buffer}>){
 const dataUri=(key:string)=>{const file=stored.get(key);return file?`data:${file.mime};base64,${file.bytes.toString('base64')}`:null;};
 const local=(value:string)=>/^(asset-\d+)(#.*)?$/.exec(value);
 const inlineCss=(text:string)=>text.replace(/url\("(asset-\d+)(#[^"]*)?"\)/g,(whole,key:string,fragment='')=>{const uri=dataUri(key);return uri?`url("${uri}${fragment}")`:whole;});
 // Fonts and images first, then stylesheets that may import each other.
 for(const file of stored.values())if(file.mime==='text/css')file.bytes=Buffer.from(inlineCss(file.bytes.toString('utf8')));
 for(const file of stored.values())if(file.mime==='text/css')file.bytes=Buffer.from(inlineCss(file.bytes.toString('utf8')));
 for(const node of nodes){
  const stylesheet=node.tagName==='link'&&node.attrs.some(a=>a.name==='rel'&&a.value.toLowerCase().split(/\s+/).includes('stylesheet'));
  const href=stylesheet?local(node.attrs.find(a=>a.name==='href')?.value??''):null;
  if(href&&stored.get(href[1])?.mime==='text/css'){
   // «</style» inside the rules would end the element early; «\/» is the same «/» in CSS.
   const css=stored.get(href[1])!.bytes.toString('utf8').replace(/<\/(style)/gi,'<\\/$1');
   Object.assign(node,{tagName:'style',nodeName:'style',attrs:[]});
   node.childNodes=[{nodeName:'#text',value:css,parentNode:node} as unknown as Tree.TextNode];
   continue;
  }
  for(const a of node.attrs){
   const key=(a.name==='src'||a.name==='poster')?local(a.value):null;
   if(key){const uri=dataUri(key[1]);if(uri)a.value=uri+(key[2]??'');}
   if(a.name==='style')a.value=inlineCss(a.value);
  }
  if(node.tagName==='style')for(const child of node.childNodes)if(child.nodeName==='#text')(child as Tree.TextNode).value=inlineCss((child as Tree.TextNode).value);
 }
 for(const key of [...stored.keys()])stored.delete(key);
}
export class HtmlCaptureError extends Error {constructor(public code:string,message:string){super(message);}}
/** A resource the viewer cannot use anyway (a font format it does not load); it is left out with a warning. */
class SkippedResource extends Error {}
const SKIPPED='\u0000polka-skipped';
const SKIPPED_FONTS=['font/ttf','font/otf','font/sfnt','font/woff','application/font-woff','application/x-font-ttf','application/x-font-otf','application/font-sfnt','application/vnd.ms-fontobject'];
const extensions:Record<string,string>={'text/html':'html','text/css':'css','text/javascript':'js','application/javascript':'js','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/svg+xml':'svg','font/woff2':'woff2'};
/** Produces a bundle, never executes source JavaScript and never saves/publishes it.
 * All dependency requests use the same public-fetch boundary as the entrypoint.
 */
export async function captureHtmlUrl(input:string,{fetcher=fetchPublic,signal}:{fetcher?:Fetcher;signal?:AbortSignal}={}) {
 const timeout=AbortSignal.timeout(45_000);const abort=signal?AbortSignal.any([signal,timeout]):timeout;
 const sourceUrl=publicUrl(input);
 // AI chats and their artifacts are opened only through their own route (prepare.ts), never downloaded from here.
 if(!downloadable(sourceUrl))throw new HtmlCaptureError('provider_adapter_required','Этот сервис Полка не скачивает напрямую. Сохраните работу через агента, файлом или как ссылку.');
 const main=await fetcher(sourceUrl.href,{maxBytes:MAX_BYTES,signal:abort});
 if(!/^text\/html(?:;|$)/i.test(main.contentType))throw new HtmlCaptureError('unsupported_type','Ожидалась HTML-страница.');
 if(!downloadable(new URL(main.url)))throw new HtmlCaptureError('provider_adapter_required','Источник перенаправил на сервис, который Полка не скачивает напрямую.');
 return captureHtmlDocument(main,{fetcher,signal:abort});
}
export type CaptureOptions={fetcher?:Fetcher;signal?:AbortSignal;
 /** How the document was obtained, recorded in provenance (a rendered snapshot). */
 renderer?:'headless-snapshot-v1';
 /** A rendered snapshot, whose code already ran: drop <script>, <noscript>, inline handlers,
  * javascript: URLs and embedded frames, turn forms into plain containers, and keep it as one
  * self-contained HTML file (stylesheets inlined, images and fonts as data: URIs), which the
  * static viewer shows without an interactive build. */
 stripScripts?:boolean;
 /** Warnings known before capture (for example, «a snapshot, not the app»). */
 warnings?:string[];
 /** Where the copy came from, when that is not main.url (the Gist page rather than its API). */
 sourceUrl?:string;
 title?:string};
/** The localisation half of captureHtmlUrl: the entrypoint is already in hand
 * (fetched, rendered or read from an API); its resources still go through the
 * fetcher, within the same 5 MiB / 64 files / 45 s budget. */
export async function captureHtmlDocument(main:PublicResponse,{fetcher=fetchPublic,signal,renderer,stripScripts=false,warnings:known=[],sourceUrl:declared,title:declaredTitle}:CaptureOptions={}) {
 const timeout=AbortSignal.timeout(45_000);const abort=signal?AbortSignal.any([signal,timeout]):timeout;
 const sourceUrl=publicUrl(declared??main.url);
 const stored=new Map<string,{mime:string;bytes:Buffer}>();const paths=new Map<string,string>();let downloaded=main.bytes.length;let sequence=0;
 if(downloaded>MAX_BYTES)throw new HtmlCaptureError('too_large','Страница с ресурсами превышает 5 МиБ.');
 const request=async(url:string)=>{abort.throwIfAborted();const r=await fetcher(url,{maxBytes:MAX_BYTES-downloaded,signal:abort});downloaded+=r.bytes.length;if(downloaded>MAX_BYTES)throw new HtmlCaptureError('too_large','Страница с ресурсами превышает 5 МиБ.');return r;};
 const html=main.bytes.toString('utf8');if(!Buffer.from(html).equals(main.bytes))throw new HtmlCaptureError('unsupported_encoding','Пока поддерживается только UTF-8.');
 const doc=parse(html);const nodes:Tree.Element[]=[];
 function walk(n:Tree.Node){if('tagName'in n)nodes.push(n);if('childNodes'in n)for(const c of n.childNodes)walk(c);if('content'in n)walk(n.content);}
 walk(doc);
 if(stripScripts)for(const node of [...nodes]){
  if(node.tagName==='script'||node.tagName==='noscript'){detach(node);nodes.splice(nodes.indexOf(node),1);continue;}
  if(node.tagName==='iframe'||node.tagName==='object'||node.tagName==='embed'){detach(node);nodes.splice(nodes.indexOf(node),1);known.push('Встроенные окна страницы (iframe) в снимок не вошли.');continue;}
  // A snapshot's form cannot submit anywhere; as a form the static viewer would refuse the page.
  if(node.tagName==='form'){node.tagName='div';node.nodeName='div';node.attrs=node.attrs.filter(a=>!['action','method','target','enctype'].includes(a.name));}
  node.attrs=node.attrs.filter(a=>!a.name.startsWith('on')&&!/^\s*javascript:/i.test(a.value));
  // A rendered page's stylesheet as the viewer applies it: rel and href only; a print-only sheet is left out.
  if(node.tagName==='link'&&node.attrs.some(a=>a.name==='rel'&&a.value.toLowerCase().split(/\s+/).includes('stylesheet'))){
   const media=node.attrs.find(a=>a.name==='media')?.value.trim().toLowerCase();
   if(media&&!['all','screen'].includes(media)){detach(node);nodes.splice(nodes.indexOf(node),1);continue;}
   node.attrs=node.attrs.filter(a=>a.name==='rel'||a.name==='href').map(a=>a.name==='rel'?{...a,value:'stylesheet'}:a);
  }
 }
 let base=main.url;const baseNode=nodes.find(n=>n.tagName==='base');const baseHref=baseNode?.attrs.find(a=>a.name==='href')?.value;if(baseHref)base=publicUrl(new URL(baseHref,base).href).href;
 const warnings=new Set<string>(known);
 const knownCount=new Set(known).size;
 // A snapshot keeps the page when one of its resources cannot be copied (a font
 // service answering HTML to a non-browser, the file budget spent): that resource
 // is left out with a warning. A plain import still refuses, as before.
 async function resource(value:string,parent:string):Promise<string>{
  if(!stripScripts)return copyResource(value,parent);
  try{return await copyResource(value,parent);}
  catch(error){
   if(error instanceof SkippedResource||abort.aborted)throw error;
   warnings.add('Некоторые ресурсы страницы не сохранились (формат, размер или ошибка источника): в снимке они пропущены.');
   throw new SkippedResource();
  }
 }
 async function copyResource(value:string,parent:string):Promise<string>{
  if(!value||value.startsWith('#')||value.startsWith('data:'))return value;
  const url=publicUrl(new URL(value,parent).href);const fragment=new URL(value,parent).hash;
  const cached=paths.get(url.href);if(cached)return cached+fragment;
  if(paths.size>=63)throw new HtmlCaptureError('too_many_files','У страницы слишком много ресурсов.');
  // Reserve the URL before traversing CSS so cycles cannot cause unbounded requests.
  const key=`asset-${++sequence}`;paths.set(url.href,key);
  try{return await download(url,key,fragment);}catch(error){paths.delete(url.href);throw error;}
 }
 async function download(url:URL,key:string,fragment:string):Promise<string>{
  // A font the viewer does not load is not downloaded at all.
  if(/\.(?:ttf|otf|eot|woff)$/i.test(url.pathname)){paths.delete(url.href);warnings.add('Шрифты TTF/OTF/EOT/WOFF пропущены: просмотр подключает только WOFF2, используется запасной шрифт.');throw new SkippedResource();}
  const response=await request(url.href);const originalMime=response.contentType.split(';')[0].trim().toLowerCase();const extension=extensions[originalMime];
  if(SKIPPED_FONTS.includes(originalMime)){paths.delete(url.href);warnings.add('Шрифты TTF/OTF/EOT/WOFF пропущены: просмотр подключает только WOFF2, используется запасной шрифт.');throw new SkippedResource();}
  if(!extension||originalMime==='text/html')throw new HtmlCaptureError('unsupported_asset',`Ресурс страницы ${url.hostname}${url.pathname.slice(0,80)} имеет неподдерживаемый формат (${originalMime||'без типа'}).`);
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
   if(/url\(/i.test(d.value)&&/\\/.test(d.value)){
    // A snapshot keeps the page and drops only that rule's value (large app stylesheets have a few); a plain import refuses.
    if(stripScripts){d.remove();warnings.add('Часть оформления пропущена: CSS-адреса с escape-последовательностями не поддерживаются.');continue;}
    throw new HtmlCaptureError('unsupported_css','CSS URL с escape-последовательностью пока не поддерживается.');
   }
   // A skipped font drops its entry of a comma list (@font-face src), or the whole declaration.
   const parts=[];for(const part of postcss.list.comma(d.value)){
    const matches=[...part.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)];
    let next=part,skipped=false;for(const m of matches){try{const path=await resource(m[1]??m[2]??m[3],parent);next=next.replace(m[0],()=>`url("${path}")`);}catch(error){if(!(error instanceof SkippedResource))throw error;skipped=true;}}
    if(!skipped)parts.push(next);
   }
   if(parts.length)d.value=parts.join(', ');else d.remove();
  }return tree.toString();
 }
 for(const node of nodes){
  if(node.tagName==='base'){detach(node);continue;}
  if(node.tagName==='iframe'||node.tagName==='object'||node.tagName==='embed')warnings.add('Встроенный внешний документ требует отдельного импорта.');
  node.attrs=node.attrs.filter(a=>a.name!=='integrity');
  for(const a of node.attrs){
   if(a.name==='style')a.value=await css(a.value,base);
   if(a.name==='srcset')warnings.add('Адаптивные изображения srcset ещё не локализованы.');
   const stylesheet=node.tagName==='link'&&node.attrs.some(x=>x.name==='rel'&&x.value.toLowerCase().split(/\s+/).includes('stylesheet'));
   // A CDN library or Tailwind stays a recognisable URL: the runtime replaces it with Полка's vendored copy.
   // A snapshot downloads CDN stylesheets too: it is inlined, there is no runtime to supply them.
   if(!stripScripts&&((a.name==='src'&&node.tagName==='script')||(a.name==='href'&&stylesheet))&&a.value&&cdnRole(new URL(a.value,base).href)){a.value=new URL(a.value,base).href;continue;}
   // Icons and other link hints are not downloaded; the interactive build leaves them out.
   if(a.name==='href'&&node.tagName==='link'&&!stylesheet){if(a.value)a.value=new URL(a.value,base).href;continue;}
   if((a.name==='src'&&['script','img','source','video','audio'].includes(node.tagName))||(a.name==='poster'&&node.tagName==='video')||(a.name==='href'&&stylesheet)){
    try{a.value=await resource(a.value,base);}
    catch(error){if(!(error instanceof SkippedResource))throw error;a.value=SKIPPED;}
   }
  }
  // A left-out stylesheet goes with its element; a left-out image or media keeps its element without the address.
  if(node.attrs.some(a=>a.value===SKIPPED)){
   if(node.tagName==='link'){detach(node);continue;}
   node.attrs=node.attrs.filter(a=>a.value!==SKIPPED);
  }
  if(node.tagName==='style')for(const child of node.childNodes)if(child.nodeName==='#text') (child as Tree.TextNode).value=await css((child as Tree.TextNode).value,base);
 }
 // This is a conservative compatibility diagnostic, not a security boundary or
 // proof that arbitrary JavaScript is offline. The viewer CSP remains authoritative.
 if(stripScripts){
  inlineInto(nodes,stored);
  // Whatever still points outside (an SVG <image src>, a lazy data-src) cannot load in the viewer and would keep the page off the static view.
  for(const node of nodes)node.attrs=node.attrs.filter(a=>!(/(?:src|action)$/i.test(a.name)&&/^\s*(?:[a-z][\w+.-]*:|\/\/)/i.test(a.value)&&!/^\s*data:/i.test(a.value)));
 }
 const scripts = [
  ...nodes.filter(n=>n.tagName==='script').flatMap(n=>n.childNodes.filter((c):c is Tree.TextNode=>c.nodeName==='#text').map(c=>c.value)),
  ...nodes.flatMap(n=>n.attrs.filter(a=>a.name.startsWith('on')).map(a=>a.value)),
  ...[...stored.values()].filter(f=>f.mime==='text/javascript').map(f=>f.bytes.toString('utf8')),
 ];
 if(scripts.some(script=>/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b|\bimport\s*\(/.test(script)))
  warnings.add('В коде найдены возможные сетевые зависимости. Внешние API и динамическая загрузка в просмотре отключены; связанные действия могут не работать.');
 const output=Buffer.from(serialize(doc));stored.set('index.html',{mime:'text/html',bytes:output});
 // Inlined images grow by a third as base64: the one page must still fit.
 if(output.length>MAX_BYTES)throw new HtmlCaptureError('too_large','Страница с ресурсами превышает 5 МиБ.');
 const safeSource=new URL(sourceUrl);safeSource.search='';safeSource.hash='';
 const manifest=canonicalizeManifest({version:1,entrypoint:'index.html',runtime:'preserved-only-v1',files:[...stored].map(([path,{mime,bytes}])=>({path,mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})),provenance:{kind:'url',sourceUrl:safeSource.href,capturedAt:new Date().toISOString(),attribution:'Imported from a public URL by the user',license:'unknown',...(renderer?{renderer}:{})},dependencies:{status:'unknown',unresolved:[]}});
 // The same isolated build worker (and runtime) as the interactive version, off the main thread.
 // A snapshot is one script-free page: the static viewer shows it as saved, no interactive build.
 const staticProfile=stripScripts?await classifyHtmlBounded(output.toString('utf8')):null;
 if(staticProfile==='unsupported')warnings.add('Снимок нельзя показать в статичном просмотре: страница сохранена только для вас.');
 let buildOk=staticProfile!==null&&staticProfile!=='unsupported';
 if(!stripScripts){
  const built=await checkBuildInWorker(manifest,[...stored].map(([path,f])=>({path,bytes:f.bytes})));
  buildOk=built.ok;
  if(!built.ok)warnings.add(built.failed?`Интерактивная сборка не проверена: ${built.reason}`:`Интерактивная сборка недоступна: ${built.reason}`);
  else for(const warning of built.warnings??[])warnings.add(`В интерактивной версии: ${warning}`);
 }
 // Successful localization alone cannot prove arbitrary JavaScript is offline.
 const title=(declaredTitle?.trim().slice(0,MAX_TITLE))||nodes.find(n=>n.tagName==='title')?.childNodes.filter((n):n is Tree.TextNode=>n.nodeName==='#text').map(n=>n.value).join('').trim().slice(0,MAX_TITLE)||sourceUrl.hostname;
 return {title,manifest,files:[...stored].map(([path,{bytes}])=>({path,encoding:'base64' as const,data:bytes.toString('base64')})),// Warnings known up front (a snapshot's note) inform the user; only found limitations stop «ready».
 previewReady:buildOk&&warnings.size===knownCount,
 // A static snapshot needs no interactive build: the job is ready once it is saved.
 ...(staticProfile&&staticProfile!=='unsupported'?{staticReady:true as const}:{}),warnings:[...warnings]};
}
