import {MAX_BYTES} from '../../../packages/contracts/index.ts';
import {config} from '../config.ts';
import {captureHtmlDocument,HtmlCaptureError} from './html-capture.ts';
import {fetchPublic,ImportFetchError,type FetchOptions,type PublicResponse} from './public-fetch.ts';

/*
 * A GitHub Gist is read through GitHub's official REST API
 * (api.github.com/gists/<id>), never by scraping gist.github.com: the page is
 * a GitHub UI, the API is what GitHub offers for this. Without a token the API
 * allows 60 requests an hour per IP; GITHUB_TOKEN (optional) raises that. A
 * rate limit is reported as it is and never retried.
 *
 * - an HTML file becomes the page: its CSS/JS/images from the same gist are
 *   served from the API answer, anything else goes through fetchPublic and
 *   the usual localisation (captureHtmlDocument);
 * - a gist without HTML becomes a readable page of its files as code.
 */

export type GistFetcher=(url:string,options:FetchOptions&{maxBytes:number;signal:AbortSignal})=>Promise<PublicResponse>;
type GistFile={filename:string;type?:string;language?:string|null;size:number;truncated?:boolean;content?:string};
type Gist={id:string;description?:string|null;owner?:{login?:string}|null;files:Record<string,GistFile|null>};

const ID=/^[0-9a-f]{20,40}$|^\d{1,12}$/i;
/** The gist a link points to, and a file of it when the link names one (gistpreview). */
export function gistTarget(input:string):{id:string;file:string|null}|null {
 let url:URL;try{url=new URL(input);}catch{return null;}
 if(url.protocol!=='https:')return null;
 const host=url.hostname.toLowerCase();
 if(host==='gist.github.com'){
  // /<user>/<id>, /<id>, and /<user>/<id>/<revision> (the gist as it is now is read).
  const parts=url.pathname.split('/').filter(Boolean);
  const id=parts.length===1?parts[0]:parts[1];
  return id&&ID.test(id)&&parts.length<=3?{id:id.toLowerCase(),file:null}:null;
 }
 if(host==='gistpreview.github.io'){
  // gistpreview.github.io/?<id>[/<file>]
  const [id,...file]=decodeURIComponent(url.search.slice(1)).split('/');
  return id&&ID.test(id)?{id:id.toLowerCase(),file:file.join('/')||null}:null;
 }
 return null;
}

const MIMES:Record<string,string>={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml'};
const extension=(name:string)=>name.toLowerCase().split('.').pop()??'';
const isHtml=(file:GistFile)=>['html','htm'].includes(extension(file.filename));
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);

function rateLimited(error:ImportFetchError){
 const http=error.http;if(!http)return null;
 const header=(name:string)=>{const value=http.headers[name];return Array.isArray(value)?value[0]:value;};
 // GitHub signals its primary limit with 403 + x-ratelimit-remaining: 0, and secondary limits with 429 or 403 + retry-after.
 if(http.status!==429&&!(http.status===403&&(header('x-ratelimit-remaining')==='0'||header('retry-after'))))return null;
 const reset=Number(header('x-ratelimit-reset'));const retry=Number(header('retry-after'));
 const minutes=retry>0?Math.ceil(retry/60):reset>0?Math.max(1,Math.ceil((reset*1000-Date.now())/60000)):null;
 return new HtmlCaptureError('rate_limited',`GitHub временно ограничил запросы к Gist${config.GITHUB_TOKEN?'':' (60 в час без токена)'}.${minutes?` Повторите примерно через ${minutes} мин.`:' Повторите позже.'} Можно сохранить файл из gist вручную.`);
}

export async function captureGist(input:string,{fetcher=fetchPublic as GistFetcher,signal}:{fetcher?:GistFetcher;signal?:AbortSignal}={}) {
 const target=gistTarget(input);
 if(!target)throw new HtmlCaptureError('unsupported_type','Это не ссылка на GitHub Gist.');
 const timeout=AbortSignal.timeout(45_000);const abort=signal?AbortSignal.any([signal,timeout]):timeout;
 let answer:PublicResponse;
 try{
  answer=await fetcher(`https://api.github.com/gists/${target.id}`,{maxBytes:MAX_BYTES*2,signal:abort,accept:'application/vnd.github+json',
   ...(config.GITHUB_TOKEN?{authorization:`Bearer ${config.GITHUB_TOKEN}`}:{})});
 }catch(error){
  if(error instanceof ImportFetchError){
   const limited=rateLimited(error);if(limited)throw limited;
   if(error.http?.status===404)throw new HtmlCaptureError('source_unavailable','Gist не найден: он удалён или ссылка неполная.');
  }
  throw error;
 }
 let gist:Gist;
 try{gist=JSON.parse(answer.bytes.toString('utf8'));}catch{throw new HtmlCaptureError('source_unavailable','GitHub вернул неожиданный ответ.');}
 const files=Object.values(gist.files??{}).filter((f):f is GistFile=>!!f&&typeof f.filename==='string');
 if(!files.length)throw new HtmlCaptureError('unsupported_type','В gist нет файлов.');
 // The API cuts files over 1 MB; the rest would come from raw URLs, which robots.txt of gist.github.com closes.
 if(files.some(f=>f.truncated||typeof f.content!=='string'))throw new HtmlCaptureError('too_large','Файл gist больше 1 МБ: GitHub API отдаёт его не целиком. Скачайте файл и загрузите его.');
 const login=gist.owner?.login&&/^[A-Za-z0-9-]{1,39}$/.test(gist.owner.login)?gist.owner.login:null;
 const page=`https://gist.github.com/${login?`${login}/`:''}${target.id}`;
 const description=gist.description?.trim()||null;
 const requested=target.file?files.find(f=>f.filename===target.file&&isHtml(f)):undefined;
 const entry=requested??files.find(f=>f.filename.toLowerCase()==='index.html')??files.find(isHtml);
 if(entry){
  // Relative references of the page resolve against this virtual raw base and are answered from the API response.
  const base=`https://gist.githubusercontent.com/${login??'anonymous'}/${target.id}/raw/`;
  const own=new Map(files.map(f=>[base+encodeURIComponent(f.filename).replace(/%2F/g,'/'),f]));
  const local=async(url:string,options:{maxBytes:number;signal:AbortSignal}):Promise<PublicResponse>=>{
   const file=own.get(url.split(/[?#]/)[0]);
   if(!file)return fetcher(url,options);
   const bytes=Buffer.from(file.content!,'utf8');
   if(bytes.length>options.maxBytes)throw new HtmlCaptureError('too_large','Страница с ресурсами превышает 5 МиБ.');
   return {url,contentType:MIMES[extension(file.filename)]??'application/octet-stream',bytes};
  };
  const main={url:base+encodeURIComponent(entry.filename),contentType:'text/html',bytes:Buffer.from(entry.content!,'utf8')};
  return captureHtmlDocument(main,{fetcher:local,signal:abort,sourceUrl:page,...(description&&!/<title>/i.test(entry.content!)?{title:description}:{})});
 }
 // No page in the gist: its files as code, one static page without scripts.
 const title=description??files[0].filename;
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>`+
  `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px 16px;color:#1f2328}h1{font-size:24px}h2{font:600 14px ui-monospace,monospace;margin:28px 0 8px}pre{overflow:auto;padding:16px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}</style></head>`+
  `<body><h1>${escape(title)}</h1>${files.map(f=>`<h2>${escape(f.filename)}</h2><pre><code>${escape(f.content!)}</code></pre>`).join('')}</body></html>`;
 return captureHtmlDocument({url:page,contentType:'text/html',bytes:Buffer.from(html,'utf8')},{fetcher:()=>{throw new HtmlCaptureError('unsupported_asset','Страница кода не загружает ресурсов.');},signal:abort,sourceUrl:page});
}
