import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Actor} from '../artifacts.ts';
import {transaction,db} from '../db.ts';
import {config} from '../config.ts';
import {createImportJob,getImportJob,importJobView,cancelImportJob} from './jobs.ts';
import {runImportOnce,expireImportJobs} from './worker.ts';

/** What this installation's import can copy; the web reads it from /api/capabilities too. */
/** rendered-spa: allowlisted SPA hosts; server-fetch: ChatGPT shares; server-try: one attempt at a Claude artifact. The last three need the renderer. */
export function importSources(){return ['standalone-html','github-gist',...(config.RENDERED_IMPORT_ENABLED?['rendered-spa','server-fetch','server-try']:[])];}
export function registerUrlImports(app:FastifyInstance,identity:(req:FastifyRequest)=>Promise<Actor>){
 app.get('/api/imports/capabilities',async()=>({enabled:config.URL_IMPORT_ENABLED,livePreview:config.HTML_LIVE_ENABLED,sources:importSources(),providerArtifacts:false}));
 if(!config.URL_IMPORT_ENABLED)return;
 app.post('/api/imports',{bodyLimit:4096},async req=>{const actor=await identity(req);return transaction(c=>createImportJob(c,actor,req.body));});
 app.get('/api/imports/:id',async req=>{const actor=await identity(req);return transaction(async c=>importJobView(await getImportJob(c,actor,(req.params as {id:string}).id)));});
 app.delete('/api/imports/:id',async req=>{const actor=await identity(req);return transaction(c=>cancelImportJob(c,actor,(req.params as {id:string}).id));});
 let running:Promise<void>|null=null;let stopped=false;let timer:ReturnType<typeof setInterval>|undefined;
 const tick=()=>{if(stopped||running)return;running=(async()=>{await expireImportJobs();for(let i=0;i<5&&!stopped;i++){if(!await runImportOnce())break;}})().catch(()=>{app.log.error({event:'url_import.worker_failed'},'URL import worker failed');}).finally(()=>{running=null;});};
 app.addHook('onReady',async()=>{
  if(!(await db.query("SELECT to_regclass('url_import_jobs') present")).rows[0].present)throw Error('URL import requires migration 019 before enabling.');
  timer=setInterval(tick,2000);timer.unref();tick();
 });
 app.addHook('onClose',async()=>{stopped=true;if(timer)clearInterval(timer);await running;});
}
