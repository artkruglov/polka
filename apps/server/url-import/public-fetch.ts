import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from '../../../packages/public-address.ts';
import { request } from 'node:https';

export class ImportFetchError extends Error {
  /** An HTTP answer the source gave (status, Retry-After and GitHub's rate-limit headers), when there was one. */
  constructor(public code:'invalid_url'|'blocked_address'|'too_large'|'timeout'|'redirect_limit'|'source_unavailable',message:string,public http?:{status:number;headers:Record<string,string|string[]|undefined>}){super(message);}
}
/** The importer's own User-Agent. The renderer and robots.txt checks name themselves PolkaRenderer (robots.ts). */
export const IMPORTER_USER_AGENT='Polka-Artifact-Importer/1.0';
export {publicAddress};
export function publicUrl(input:string):URL {
 let url:URL;try{url=new URL(input);}catch{throw new ImportFetchError('invalid_url','Нужна корректная публичная HTTPS-ссылка.');}
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new ImportFetchError('invalid_url','Разрешены только HTTPS-ссылки без логина и нестандартного порта.');
 url.hash='';return url;
}
type Resolver=(hostname:string)=>Promise<Array<{address:string;family:number}>>;
export async function resolvePublicTarget(input:string,resolver:Resolver=hostname=>lookup(hostname,{all:true,verbatim:true})) {
 const url=publicUrl(input);const hostname=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await resolver(hostname);
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new ImportFetchError('blocked_address','Источник указывает на непубличный или зарезервированный адрес.');
 return {url,...addresses[0]};
}
export type PublicResponse={url:string;contentType:string;bytes:Buffer};
export type FetchOptions={maxBytes?:number;timeoutMs?:number;maxRedirects?:number;signal?:AbortSignal;
 /** Accept header instead of the HTML/asset default (the GitHub API wants its own). */
 accept?:string;
 /** Sent only to the first hop's host, never after a redirect to another host. */
 authorization?:string;
 userAgent?:string};
/** The request headers of one hop. Authorization goes only to the host the caller asked for. */
export function hopHeaders(first:string,hop:URL,{accept,authorization,userAgent=IMPORTER_USER_AGENT}:Pick<FetchOptions,'accept'|'authorization'|'userAgent'>):Record<string,string>{
 return {Accept:accept??'text/html,application/xhtml+xml,image/*,text/css,application/javascript;q=0.8','Accept-Encoding':'identity','User-Agent':userAgent,
  ...(authorization&&hop.host===new URL(first).host?{Authorization:authorization}:{})};
}
/** No cookies, ambient proxy or pooled connections; the only caller-set headers
 * are Accept, User-Agent and a host-bound Authorization (FetchOptions).
 * Each hop resolves once and pins that address in the TLS connection; Host/SNI
 * and certificate verification still use the original hostname.
 */
export async function fetchPublic(input:string,{maxBytes=5*1024*1024,timeoutMs=15_000,maxRedirects=3,signal,accept,authorization,userAgent=IMPORTER_USER_AGENT}:FetchOptions={}):Promise<PublicResponse> {
 const deadline=AbortSignal.timeout(timeoutMs);const abort=signal?AbortSignal.any([signal,deadline]):deadline;
 let next=input;
 try {
  for(let hop=0;hop<=maxRedirects;hop++){
   const target=await abortable(resolvePublicTarget(next),abort);
   const result=await new Promise<PublicResponse|{redirect:string}>((resolve,reject)=>{
    const req=request(target.url,{method:'GET',agent:false,family:target.family,signal:abort,
     lookup:(_host,_opts,cb)=>cb(null,target.address,target.family),
     headers:hopHeaders(input,target.url,{accept,authorization,userAgent})},res=>{
      const status=res.statusCode??0;
      if([301,302,303,307,308].includes(status)){
       const location=res.headers.location;res.destroy();
       if(!location)return reject(new ImportFetchError('source_unavailable','Источник вернул редирект без адреса.'));
       try{resolve({redirect:publicUrl(new URL(location,target.url).href).href});}catch(e){reject(e);}return;
      }
      if(status<200||status>=300){res.destroy();reject(new ImportFetchError('source_unavailable',`Источник вернул HTTP ${status}.`,{status,headers:res.headers}));return;}
      if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new ImportFetchError('source_unavailable','Источник вернул неподдерживаемое сжатие.'));return;}
      const length=Number(res.headers['content-length']??0);
      if(length>maxBytes){res.destroy();reject(new ImportFetchError('too_large','Ответ источника превышает лимит.'));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){reject(new ImportFetchError('too_large','Ответ источника превышает лимит.'));res.destroy();}else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({url:target.url.href,contentType:res.headers['content-type']??'',bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
   });
   if('bytes'in result)return result;
   next=result.redirect;
  }
  throw new ImportFetchError('redirect_limit','Слишком много перенаправлений источника.');
 }catch(e){
  if(e instanceof ImportFetchError)throw e;
  if(abort.aborted)throw new ImportFetchError('timeout',signal?.aborted?'Импорт отменён.':'Источник не ответил вовремя.');
  throw new ImportFetchError('source_unavailable','Не удалось безопасно получить содержимое источника.');
 }
}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});
}
