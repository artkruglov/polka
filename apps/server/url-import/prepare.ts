import {matchLink} from '../../../packages/contracts/link-providers.ts';
import {config} from '../config.ts';
import {captureHtmlUrl,HtmlCaptureError} from './html-capture.ts';
import {captureGist} from './gist.ts';
import {captureRendered,type RenderedOptions} from './rendered.ts';
import {captureChatgpt,type ChatgptOptions} from './providers/chatgpt.ts';

export type PrepareOptions={
 /** The job moves to «rendering» here: the renderer is about to open or fetch the page. */
 onRendering?:()=>Promise<void>;
 rendered?:Omit<RenderedOptions,'onRendering'>;
 chatgpt?:Omit<ChatgptOptions,'onFetching'>;
 /** Test hook for RENDERED_IMPORT_ENABLED. */
 renderedEnabled?:boolean;
};

const EXTENSION_ONLY='Этот сервис Полка не открывает сервером. Сохраните работу через агента, файлом или как ссылку.';

/** Picks how a queued link is copied, by its route in the provider table
 * (packages/contracts/link-providers.ts). Links the server may not open
 * never reach the network from here; ChatGPT and Claude pages are opened
 * only by the renderer, never by this server. */
export async function prepareImport(url:string,{onRendering,rendered,chatgpt,renderedEnabled=config.RENDERED_IMPORT_ENABLED}:PrepareOptions={}){
 const match=matchLink(url);
 if(!match||match.route==='html')return captureHtmlUrl(url);
 if(match.closed&&match.route!=='server-render')throw new HtmlCaptureError('provider_adapter_required',EXTENSION_ONLY);
 switch(match.route){
  case 'extension':throw new HtmlCaptureError('provider_adapter_required',EXTENSION_ONLY);
  case 'server-api':return captureGist(url);
  case 'server-fetch':
   if(!renderedEnabled)throw new HtmlCaptureError('provider_adapter_required',EXTENSION_ONLY);
   return captureChatgpt(url,{...chatgpt,onFetching:onRendering});
  case 'server-try':
   if(!renderedEnabled)throw new HtmlCaptureError('provider_adapter_required',EXTENSION_ONLY);
   return captureRendered(url,{...rendered,onRendering});
  case 'server-render':
   if(renderedEnabled&&!match.closed)return captureRendered(url,{...rendered,onRendering});
   // A Gemini share page is an empty shell without the renderer; other SPA hosts may still be plain pages.
   if(match.provider?.id==='gemini')throw new HtmlCaptureError('renderer_disabled','Чат Gemini собирается скриптами, а серверный рендер на этой установке выключен. Сохраните его через агента, файлом или как ссылку.');
   return captureHtmlUrl(url);
 }
}
