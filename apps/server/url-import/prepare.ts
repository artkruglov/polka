import {matchLink} from '../../../packages/contracts/link-providers.ts';
import {captureHtmlUrl,HtmlCaptureError} from './html-capture.ts';
import {captureGist} from './gist.ts';

/** Picks how a queued link is copied, by its route in the provider table
 * (packages/contracts/link-providers.ts). Links of extension-only services
 * never reach the network from here. */
export async function prepareImport(url:string){
 const match=matchLink(url);
 if(match?.route==='extension')throw new HtmlCaptureError('provider_adapter_required','Этот сервис запрещает автоматическое извлечение: Полка не открывает такие ссылки сервером. Сохраните расширением «На Полку», через агента или файлом.');
 if(match?.route==='server-api')return captureGist(url);
 // A Gemini share page is an empty shell without the renderer; other SPA hosts may still be plain pages.
 if(match?.route==='server-render'&&match.provider?.id==='gemini')throw new HtmlCaptureError('renderer_disabled','Чат Gemini собирается скриптами, а серверный рендер на этой установке выключен. Сохраните его расширением, через агента или файлом.');
 return captureHtmlUrl(url);
}
