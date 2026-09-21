import test from 'node:test';
import assert from 'node:assert/strict';
import {captureHtmlUrl} from '../apps/server/url-import/html-capture.ts';
import {validateAgentCapture} from '../apps/server/agent-capture.ts';
const base='https://example.org/';
function source(entries:Record<string,[string,string]>,requests:string[]=[]){return async(url:string)=>{requests.push(url);const e=entries[url];if(!e)throw Error('missing fixture');return {url,contentType:e[0],bytes:Buffer.from(e[1])};};}
test('HTML importer produces a capture-compatible bundle with CSS and image dependencies',async()=>{
 const requests:string[]=[];
 const result=await captureHtmlUrl(base+'report.html?secret=x',{fetcher:source({
  [base+'report.html?secret=x']:['text/html','<!doctype html><title>Report</title><link rel="stylesheet" href="styles/main.css"><h1>Report</h1><img src="image.svg">'],
  [base+'styles/main.css']:['text/css','h1{color:blue;background:url(../image.svg)}'],
  [base+'image.svg']:['image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>'],
 },requests)});
 assert.equal(result.title,'Report');assert.equal(result.files.length,3);assert.equal(requests.filter(r=>r.endsWith('image.svg')).length,1);
 assert.equal(result.manifest.provenance.sourceUrl,base+'report.html');
 const parsed=validateAgentCapture({key:'12345678-1234-4234-8234-123456789012',title:result.title,manifest:result.manifest,files:result.files},'capture');
 assert.ok(parsed.source.get('index.html')?.toString().includes('asset-1'));
 assert.ok(parsed.source.get('asset-1')?.toString().includes('asset-2'));
 assert.equal(result.previewReady,true,JSON.stringify(result.warnings));
});
test('HTML importer does not mistake provider shells or non-HTML for an artifact',async()=>{
 await assert.rejects(captureHtmlUrl('https://claude.ai/public/artifacts/a'),{code:'provider_adapter_required'});
 await assert.rejects(captureHtmlUrl(base,{fetcher:source({[base]:['application/json','{}']})}),{code:'unsupported_type'});
});
test('missing dependencies fail capture and external iframe cannot claim preview ready',async()=>{
 await assert.rejects(captureHtmlUrl(base,{fetcher:source({[base]:['text/html','<img src="missing.png">']})}));
 const result=await captureHtmlUrl(base,{fetcher:source({[base]:['text/html','<h1>Remote</h1><iframe src="https://other.example"></iframe>']})});assert.equal(result.previewReady,false);assert.ok(result.warnings.length);
});

test('self-contained interactive HTML can be prepared for the isolated viewer',async()=>{
 const result=await captureHtmlUrl(base,{fetcher:source({[base]:['text/html','<!doctype html><title>Counter</title><button id="counter">0</button><script>document.getElementById("counter").onclick=function(){this.textContent=Number(this.textContent)+1}</script>']})});
 assert.equal(result.previewReady,true,JSON.stringify(result.warnings));
});

test('network-dependent inline, handler and downloaded JavaScript cannot claim a complete preview',async()=>{
 for(const html of [
  '<button onclick="fetch(\'/api/data\')">Load</button>',
  '<script>new WebSocket("wss://example.org/live")</script>',
  '<script src="app.js"></script>',
 ]){
  const result=await captureHtmlUrl(base,{fetcher:source({
   [base]:['text/html',html],
   [base+'app.js']:['text/javascript','fetch("/api/data").then(console.log)'],
  })});
  assert.equal(result.previewReady,false);
  assert.ok(result.warnings.some(w=>w.includes('сетевые зависимости')));
  assert.ok(result.files.some(f=>f.path==='index.html'));
 }
});

test('compatibility corpus preserves copies while declaring unsupported viewer features',async()=>{
 const cases=[
  ['module','<script type="module">export const x=1</script>'],
  ['srcset','<img srcset="wide.png 2x" alt="responsive">'],
  ['css-import','<style>@import "theme.css";</style>'],
  ['iframe','<iframe src="https://example.org/embedded"></iframe>'],
 ];
 for(const [name,html] of cases){
  const result=await captureHtmlUrl(base,{fetcher:source({
   [base]:['text/html',html], [base+'theme.css']:['text/css','body{color:blue}'],
  })});
  assert.equal(result.previewReady,false,name);
  assert.ok(result.warnings.length,name);
  assert.ok(result.files.some(f=>f.path==='index.html'),name);
 }
});

test('redirected provider shells and invalid UTF-8 cannot masquerade as a saved artifact',async()=>{
 await assert.rejects(captureHtmlUrl(base,{fetcher:async()=>({url:'https://chatgpt.com/share/example',contentType:'text/html',bytes:Buffer.from('<div id="root"></div>')})}),{code:'provider_adapter_required'});
 await assert.rejects(captureHtmlUrl(base,{fetcher:async()=>({url:base,contentType:'text/html',bytes:Buffer.from([0xff,0xfe])})}),{code:'unsupported_encoding'});
});
