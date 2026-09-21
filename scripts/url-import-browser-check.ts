import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { registerFrontend } from "../apps/server/frontend.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
if (!new URL(config.DATABASE_URL).pathname.startsWith("/polka_import_test_"))
  throw Error("Disposable test database required");
// Synthetic local account in a disposable DB; never used by the real application.
const proofOwner=await createAccount("browser-proof", "local-browser-review-only-2026");
if(process.env.AGENT_CONTEXT_BROWSER_SEED === "true"){
 const {prepareCapture}=await import("./prepare-capture.ts");
 const {captureFromAgent}=await import("../apps/server/agent-capture.ts");
 const {authenticateServiceToken,MCP_AUDIENCE}=await import("../apps/server/service-auth.ts");
 const {sha256}=await import("../apps/server/storage.ts");
 const {randomUUID,randomBytes}=await import("node:crypto");
 const token=randomBytes(32).toString("base64url");
 await db.query(`INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at) VALUES($1,$2,$3,$4,'acceptance fixture',ARRAY['capture','context','source:read','revise'],$5,now()+interval '1 day')`,[randomUUID(),proofOwner.tenant,proofOwner.id,sha256(token),MCP_AUDIENCE]);
 const actor=await authenticateServiceToken(token,MCP_AUDIENCE);
 const bundle=await prepareCapture("tests/fixtures/bundle-corpus/team-report","index.html",["index.html","assets/report.css","assets/report.js","assets/mark.svg"]);
 const receipt=await captureFromAgent(actor,{...bundle,key:randomUUID(),title:"Демо · еженедельный отчёт команды"},"capture");
 if(process.env.TEMPLATE_CATALOG_BROWSER_SEED === "true"){
  const {publishTemplate}=await import("../apps/server/agent-context.ts");
  const {transaction}=await import("../apps/server/db.ts");
  await transaction(c=>publishTemplate(c,proofOwner,receipt.artifactId,{
   revisionId:receipt.revisionId,summary:"Еженедельный отчёт: первая редакция",rules:"Используйте оформление. Замените демонстрационные данные.",
  }));
  const next=await captureFromAgent(actor,{...bundle,key:randomUUID(),title:"Демо · еженедельный отчёт команды",artifactId:receipt.artifactId,baseRevisionId:receipt.revisionId},"revise");
  await transaction(c=>publishTemplate(c,proofOwner,receipt.artifactId,{
   revisionId:next.revisionId,summary:"Отчёт руководителю: результаты, риски и следующие шаги",rules:"Сохраните сетку и типографику. Все демонстрационные данные замените.",questions:"Какой период? Где источники цифр?",
  }));
 }
 if(process.env.TEMPLATE_LIBRARY_BROWSER_SEED === "true"){
  const {publishTemplate}=await import("../apps/server/agent-context.ts");
  const {transaction}=await import("../apps/server/db.ts");
  const {createTemplateLibrary,publishTemplateLibraryRelease,createTemplateLibraryInvitation,acceptTemplateLibraryInvitation}=await import("../apps/server/template-libraries.ts");
  const release=await transaction(c=>publishTemplate(c,proofOwner,receipt.artifactId,{
   revisionId:receipt.revisionId,summary:"Отчёт команды: результаты, риски, следующие шаги",rules:"Сохраните типографику. Замените все демонстрационные данные.",questions:"За какой период готовим отчёт?",
  }));
  const library=await createTemplateLibrary(proofOwner,{name:"Демо · библиотека команды"});
  await publishTemplateLibraryRelease(proofOwner,library.id,{releaseId:release.releaseId});
  if(process.env.TEMPLATE_LIBRARY_BROWSER_PREPARED === "true"){
   // Build genuine fixture bytes as their owner; this does not prove member-initiated preparation.
   const {buildInlineRevision}=await import("../apps/server/bundle-derivatives.ts");
   const build=await buildInlineRevision(proofOwner,receipt.revisionId);
   if(build.status.state !== "ready")throw Error("Synthetic library bundle did not prepare successfully");
  }
  if(process.env.TEMPLATE_LIBRARY_BROWSER_TEXT === "true"){
   const {beginUpload,uploadBytes,finalizeUpload}=await import("../apps/server/artifacts.ts");
   const bytes=Buffer.from("Демо: структура отчёта\n1. Итоги\n2. Риски\n3. Следующие шаги\nВсе данные для примера.");
   const started=await beginUpload(proofOwner,{key:randomUUID(),title:"Демо · текстовая структура отчёта",filename:"структура.txt",mime:"text/plain",size:bytes.length,sha256:sha256(bytes)});
   await uploadBytes(proofOwner,started.uploadId,bytes);
   const saved=await finalizeUpload(proofOwner,started.uploadId);
   const textRelease=await transaction(c=>publishTemplate(c,proofOwner,saved.artifactId,{revisionId:saved.revisionId,summary:"Текстовый шаблон структуры отчёта",rules:"Сохраните разделы, замените демонстрационные данные."}));
   await publishTemplateLibraryRelease(proofOwner,library.id,{releaseId:textRelease.releaseId});
  }
  const reader=await createAccount("library-reader","local-browser-review-only-2026");
  // Synthetic verified identity ONLY inside the guarded disposable browser DB.
  // Production and local email-delivery verification remain unchanged.
  await db.query("UPDATE accounts SET email='library-reader@example.test',email_verified_at=now() WHERE id=$1",[reader.id]);
  const invitation=await createTemplateLibraryInvitation(proofOwner,library.id,{email:"library-reader@example.test"});
  if(process.env.TEMPLATE_LIBRARY_BROWSER_JOINED === "true"){
   const token=new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get("token");
   await acceptTemplateLibraryInvitation(reader,library.id,{token});
  }
  const proofPath=process.env.TEMPLATE_LIBRARY_BROWSER_PROOF_FILE;
  if(!proofPath?.startsWith("/tmp/polka-library-"))throw Error("Explicit temporary library proof path required");
  await writeFile(proofPath,JSON.stringify({origin:config.APP_ORIGIN,libraryId:library.id,invitationUrl:invitation.invitationUrl,readerName:"library-reader"}),{mode:0o600});
  if(process.env.TEMPLATE_LIBRARY_AGENT_PROOF_FILE){
   const agentPath=process.env.TEMPLATE_LIBRARY_AGENT_PROOF_FILE;
   if(!agentPath.startsWith("/tmp/polka-library-agent-"))throw Error("Explicit temporary agent proof path required");
   if(process.env.TEMPLATE_LIBRARY_BROWSER_JOINED !== "true")throw Error("Agent acceptance requires an active reader");
   const readerToken=randomBytes(32).toString("base64url");
   await db.query(`INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at) VALUES($1,$2,$3,$4,'synthetic real-agent acceptance',$6,$5,now()+interval '30 minutes')`,[randomUUID(),reader.tenant,reader.id,sha256(readerToken),MCP_AUDIENCE,process.env.TEMPLATE_LIBRARY_CAPTURE_ACCEPTANCE === 'true' ? ['source:read','capture','context'] : ['source:read']]);
   await writeFile(agentPath,JSON.stringify({origin:config.APP_ORIGIN,token:readerToken,libraryId:library.id,artifactId:receipt.artifactId,revisionId:receipt.revisionId}),{mode:0o600,flag:"wx"});
  }
  console.log("Synthetic library and invitation prepared; proof saved to temporary file.");
 }
 if(process.env.READER_HISTORY_BROWSER_SEED === "true")await captureFromAgent(actor,{...bundle,key:randomUUID(),title:"Демо · еженедельный отчёт команды",artifactId:receipt.artifactId,baseRevisionId:receipt.revisionId},"revise");
 console.log(`Template acceptance: ${config.APP_ORIGIN}/works/${receipt.artifactId}`);
}
const app = await createApp();
// Optional fault injection belongs only to this guarded disposable fixture.
// The production server has no fault-control endpoint or file hook.
const faultFile = process.env.URL_IMPORT_BROWSER_FAULT_FILE;
if (faultFile) app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "GET" || !/^\/api\/imports\/[0-9a-f-]{36}$/.test(request.url)) return;
  const mode = (await readFile(faultFile, "utf8")).trim();
  const status = Number(mode);
  if ([403,404,503].includes(status)) return reply.code(status).send({code:"acceptance_fault",message:status===503 ? "Тестовый сервер временно недоступен. Повторите проверку." : "Задание недоступно."});
});
const templateFaultFile = process.env.TEMPLATE_BROWSER_FAULT_FILE;
if (templateFaultFile) app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "GET" || request.url.split("?")[0] !== "/api/templates") return;
  const mode = (await readFile(templateFaultFile, "utf8")).trim();
  if (mode === "503") return reply.code(503).send({
    code: "acceptance_fault", message: "Не удалось загрузить шаблоны. Сервер временно недоступен.",
  });
});
// UI-only response simulation, available exclusively in this disposable DB fixture.
const libraryFaultFile = process.env.TEMPLATE_LIBRARY_VIEWER_FAULT_FILE;
if (libraryFaultFile) {
 if (!libraryFaultFile.startsWith("/tmp/polka-library-")) throw Error("Temporary viewer fault file required");
 app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "POST" || !/^\/api\/template-libraries\/[^/]+\/publications\/[^/]+\/(prepare-live-view|live-view)$/.test(request.url)) return;
  const mode = (await readFile(libraryFaultFile, "utf8")).trim();
  if (["403", "404", "429", "503"].includes(mode)) return reply.code(Number(mode)).send({code:mode === "429" ? "quota" : "acceptance_fault", message:"Тестовый отказ просмотра"});
  if (["pending", "unsupported", "failed"].includes(mode)) return reply.code(409).send({status:"preparation_required",build:{state:mode}});
 });
}
const viewer = await createLiveViewerApp();
await registerFrontend(app, fileURLToPath(new URL("../dist", import.meta.url)));
if(process.env.TEMPLATE_OFFLINE_EXPORT_DIR){
 const dir=process.env.TEMPLATE_OFFLINE_EXPORT_DIR;
 if(!dir.startsWith("/tmp/polka-offline-"))throw Error("Temporary offline export directory required");
 const {mkdir}=await import("node:fs/promises");
 await mkdir(dir,{recursive:true});
 const login=await app.inject({method:"POST",url:"/api/login",headers:{origin:config.APP_ORIGIN},payload:{name:"library-reader",password:"local-browser-review-only-2026"}});
 if(login.statusCode!==200)throw Error("Synthetic reader login failed");
 const cookie=login.cookies.map(x=>`${x.name}=${x.value}`).join("; ");
 const proof=JSON.parse(await readFile(process.env.TEMPLATE_LIBRARY_BROWSER_PROOF_FILE!,"utf8"));
 const catalog=await app.inject({url:`/api/templates?libraryId=${proof.libraryId}`,headers:{cookie}});
 const template=catalog.json().items[0];
 const params=new URLSearchParams({revisionId:template.revisionId,libraryId:proof.libraryId,publicationId:template.publicationId,purpose:"style"});
 const exported=await app.inject({url:`/api/artifacts/${template.artifactId}/agent-package?${params}`,headers:{cookie}});
 if(exported.statusCode!==200)throw Error("Synthetic template export failed");
 await writeFile(`${dir}/template.zip`,exported.rawPayload);
 const {beginUpload,uploadBytes,finalizeUpload}=await import("../apps/server/artifacts.ts");
 const {sha256}=await import("../apps/server/storage.ts");
 const {randomUUID}=await import("node:crypto");
 const bytes=Buffer.from("Источник фактов, синтетический. Период: 14–20 сентября. Завершено 7 интервью и 3 прототипа. Риск: два респондента перенесли встречи. Следующий шаг: проверить прототип с 6 участниками. Старые числа из шаблона не использовать.");
 const begun=await beginUpload(proofOwner,{key:randomUUID(),title:"Факты недели · синтетический источник",filename:"facts.txt",mime:"text/plain",size:bytes.length,sha256:sha256(bytes)});
 await uploadBytes(proofOwner,begun.uploadId,bytes);const facts=await finalizeUpload(proofOwner,begun.uploadId);
 const ownerLogin=await app.inject({method:"POST",url:"/api/login",headers:{origin:config.APP_ORIGIN},payload:{name:"browser-proof",password:"local-browser-review-only-2026"}});
 if(ownerLogin.statusCode!==200)throw Error("Synthetic owner login failed");
 const ownerCookie=ownerLogin.cookies.map(x=>`${x.name}=${x.value}`).join("; ");
 const factsExport=await app.inject({url:`/api/artifacts/${facts.artifactId}/agent-package?revisionId=${facts.revisionId}&purpose=source`,headers:{cookie:ownerCookie}});
 if(factsExport.statusCode!==200)throw Error("Synthetic facts export failed");
 await writeFile(`${dir}/facts.zip`,factsExport.rawPayload);
 await writeFile(`${dir}/expected.json`,JSON.stringify({template,factsArtifactId:facts.artifactId,factsRevisionId:facts.revisionId}));
 console.log("Offline acceptance packages exported through authenticated API.");
}


await app.listen({ host: config.HOST, port: config.PORT });
await viewer.listen({ host: config.VIEWER_HOST, port: config.VIEWER_PORT });
console.log(`Browser acceptance: ${config.APP_ORIGIN}/bring?url=`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await viewer.close();
    const rows = await db.query(
      `SELECT object_key,object_version FROM revision_files UNION SELECT object_key,object_version FROM revisions UNION SELECT object_key,object_version FROM upload_files UNION SELECT object_key,object_version FROM revision_derivatives WHERE object_key IS NOT NULL`,
    );
    for (const row of rows.rows)
      await s3.send(
        new DeleteObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: row.object_key,
          VersionId: row.object_version,
        }),
      );
  } finally {
    await db.end();
    s3.destroy();
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => void close());
