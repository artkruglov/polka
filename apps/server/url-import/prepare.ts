import {captureHtmlUrl} from './html-capture.ts';
import {captureGist,gistTarget} from './gist.ts';

/** Picks how a queued link is copied: a gist through the GitHub API, anything else as a public HTML page. */
export async function prepareImport(url:string){
 return gistTarget(url)?captureGist(url):captureHtmlUrl(url);
}
