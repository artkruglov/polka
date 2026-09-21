import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createAccount} from '../apps/server/auth.ts';
import {db} from '../apps/server/db.ts';
import {s3} from '../apps/server/storage.ts';
import {captureHtmlUrl} from '../apps/server/url-import/html-capture.ts';
import {captureForOwner} from '../apps/server/agent-capture.ts';
import {exportRevision} from '../apps/server/artifacts.ts';

after(async()=>{await db.end();s3.destroy();});
test('URL bundle persists with owner isolation and an idempotent receipt',async()=>{
 const owner=await createAccount('url-save-'+randomBytes(5).toString('hex'),randomBytes(24).toString('hex'));
 const other=await createAccount('url-other-'+randomBytes(5).toString('hex'),randomBytes(24).toString('hex'));
 const result=await captureHtmlUrl('https://example.org/report',{fetcher:async url=>({url,contentType:'text/html',bytes:Buffer.from('<!doctype html><title>Independent report</title><h1>Saved without source</h1>')})});
 const payload={key:randomUUID(),title:result.title,manifest:result.manifest,files:result.files};
 const first=await captureForOwner(owner,payload);const second=await captureForOwner(owner,payload);
 assert.deepEqual(second,first);
 const stored=await db.query('SELECT manifest FROM revisions WHERE id=$1 AND tenant_id=$2',[first.revisionId,owner.tenant]);
 assert.equal(stored.rows[0].manifest.provenance.kind,'url');
 assert.equal(stored.rows[0].manifest.provenance.sourceUrl,'https://example.org/report');
 await assert.rejects(exportRevision(other,first.revisionId));
 await assert.rejects(captureForOwner({...owner,connectionId:randomUUID()},payload),{status:403});
 await assert.rejects(captureForOwner(owner,{...payload,title:'Changed request'}),{status:409});
});
