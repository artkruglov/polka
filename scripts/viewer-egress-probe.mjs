// Viewer egress probe (docs/reviews/2026-09-23-viewer-egress): opens a share
// link as a guest in a fresh headless Chrome, attaches to the viewer iframe
// over the DevTools protocol, records every network request and its outcome,
// and reads the report of the probe page (tests/fixtures/viewer-egress-probe.html,
// published to the installation first).
//   node scripts/viewer-egress-probe.mjs "https://<app>/s#<token>"
// Browser-side observation only: it is not an independent collector.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const shareUrl = process.argv[2];
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(path.join(tmpdir(), "egress-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
let port = 0;
for (let i = 0; i < 120 && !port; i++) {
  try { port = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
  if (!port) await wait(250);
}
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const pending = new Map(); const handlers = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else handlers.forEach((h) => h(m));
};
const send = (method, params = {}, sessionId) => new Promise((ok) => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });

const requests = new Map(); const csp = []; const frames = new Map(); const consoleReport = [];
handlers.push(async (m) => {
  const s = m.sessionId;
  if (m.method === "Target.targetInfoChanged") for (const [sid, info] of frames) if (info.targetId === m.params.targetInfo.targetId) frames.set(sid, m.params.targetInfo);
  if (m.method === "Target.attachedToTarget") {
    const sid = m.params.sessionId; frames.set(sid, m.params.targetInfo);
    await send("Network.enable", {}, sid);
    await send("Log.enable", {}, sid);
    await send("Runtime.enable", {}, sid);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
    await send("Runtime.runIfWaitingForDebugger", {}, sid);
  }
  if (m.method === "Network.requestWillBeSent") requests.set(m.params.requestId, { url: m.params.request.url, frame: frames.get(s)?.url?.slice(0, 40) ?? "page", outcome: "sent" });
  if (m.method === "Network.responseReceived") { const r = requests.get(m.params.requestId); if (r) r.outcome = `response ${m.params.response.status}`; }
  if (m.method === "Network.loadingFailed") { const r = requests.get(m.params.requestId); if (r) r.outcome = `failed ${m.params.blockedReason ?? m.params.errorText}`; }
  if (m.method === "Runtime.consoleAPICalled") { const v = m.params.args?.[0]?.value; if (typeof v === "string" && v.startsWith("PROBE_")) consoleReport.push(v); }
  if (m.method === "Log.entryAdded" && /Content Security Policy|sandbox/i.test(m.params.entry.text)) csp.push(m.params.entry.text.slice(0, 160));
});

const { targetId } = (await send("Target.createTarget", { url: "about:blank" })).result;
const { sessionId: page } = (await send("Target.attachToTarget", { targetId, flatten: true })).result;
frames.set(page, { url: "top" });
for (const d of ["Network.enable", "Log.enable", "Runtime.enable", "Page.enable"]) await send(d, {}, page);
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
await send("Page.navigate", { url: shareUrl }, page);

// Wait for the viewer frame, then for the probe to report.
let report = null; const seen = new Set(); const viewerSessions = new Map();
for (let i = 0; i < 90 && !report; i++) {
  await wait(500);
  const { targetInfos = [] } = (await send("Target.getTargets")).result ?? {};
  for (const t of targetInfos) {
    if (!/polochka\.page/.test(t.url) || viewerSessions.has(t.targetId)) continue;
    const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    if (a.result?.sessionId) { viewerSessions.set(t.targetId, a.result.sessionId); seen.add(t.url.replace(/document\/[^/?#]+/, "document/<grant>")); }
  }
  for (const sid of viewerSessions.values()) {
    const r = await send("Runtime.evaluate", { expression: "document.title==='done' ? document.getElementById('out').textContent : document.title", returnByValue: true }, sid);
    const v = r.result?.result?.value;
    if (v && v.startsWith("{")) report = v;
  }
  if (!report && consoleReport.some((c) => c.startsWith("PROBE_REPORT"))) report = consoleReport.find((c) => c.startsWith("PROBE_REPORT")).slice(13);
  if (report) { await wait(4000); break; }
  {
  }
}
console.log("viewer frames:", [...seen]);
console.log("\nprobe report:", report ?? "(no report — the probe did not finish)");
console.log("\nconsole:", consoleReport.filter((c) => !c.startsWith("PROBE_REPORT")));
console.log("\nrequests leaving polochka.app/polochka.page:");
for (const r of requests.values()) if (!/^https:\/\/(polochka\.app|polochka\.page)\//.test(r.url) && !r.url.startsWith("data:")) console.log(" ", r.outcome.padEnd(34), r.url.slice(0, 90));
console.log("\nCSP/sandbox console messages:", csp.length); csp.slice(0, 12).forEach((c) => console.log("  -", c));
ws.close(); chrome.kill(); await wait(500); if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
