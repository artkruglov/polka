// The «На Полку» bookmarklet (extensions/bookmarklet) and Полка's
// /bring/receive page (packages/contracts/bookmarklet.ts).
//
// Unit: the protocol's checks, the javascript: address, the upload schema's
// sourceUrl. Browser (a real headless Chrome over CDP; skips without Chrome or
// openssl): the built bookmarklet runs in the synthetic claude.ai fixture
// (tests/fixtures/extension/), served at https://claude.ai/… from this machine:
// Chrome goes through a local proxy that tunnels claude.ai and evil.test to a
// fixture HTTPS server (a certificate made here, never committed), passes
// APP_ORIGIN to this test's Полка and refuses everything else, so nothing
// leaves the computer. The chain: click → Полка tab → card → sign in → save →
// the work, with the page's address in provenance. Forged messages (another
// nonce, another origin, not the opener) are ignored; no file is downloaded;
// the page's functions are its own again.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  BOOKMARKLET_MESSAGE,
  acceptBookmarkletEvent,
  allowedSourceOrigin,
  checkSource,
  nonceFromHash,
  parseBookmarkletReply,
  provenanceUrl,
  utf8Bytes,
} from "../packages/contracts/bookmarklet.ts";
import { beginUploadSchema } from "../packages/contracts/index.ts";
import {
  ORIGIN_PLACEHOLDER,
  bookmarkletScript,
  javascriptUrl,
} from "../extensions/bookmarklet/build.ts";

// --- Unit ------------------------------------------------------------------

const NONCE = "n".repeat(12) + "0123456789abcdef_-AB";
const CLAUDE = "https://claude.ai";
const source = (extra: Record<string, unknown> = {}) => ({
  url: `${CLAUDE}/artifact/0f6e1b2a`,
  title: "Трекер",
  kind: "artifact",
  language: "html",
  text: "<!doctype html><p>x</p>",
  ...extra,
});
const opener = {};
const event = (data: unknown, extra: Partial<{ origin: string; source: unknown }> = {}) => ({
  origin: CLAUDE,
  source: opener,
  data,
  ...extra,
});
const message = (extra: Record<string, unknown> = {}) => ({
  type: BOOKMARKLET_MESSAGE,
  nonce: NONCE,
  source: source(),
  ...extra,
});

test("source origins: the AI chats' https origins only", () => {
  for (const origin of ["https://claude.ai", "https://chatgpt.com", "https://chat.openai.com", "https://gemini.google.com"])
    assert.equal(allowedSourceOrigin(origin), true, origin);
  for (const origin of ["http://claude.ai", "https://claude.ai:8443", "https://evil.claude.ai", "https://claude.ai.evil.test", "https://claude.ai/", "null", "", 1])
    assert.equal(allowedSourceOrigin(origin), false, String(origin));
});

test("the receiving tab accepts one well-formed message from its opener", () => {
  const expected = { opener, nonce: NONCE };
  const accepted = acceptBookmarkletEvent(event(message()), expected);
  assert.equal(accepted?.status, "source");
  // Forged: another nonce, another window, another origin, no nonce, no opener.
  assert.equal(acceptBookmarkletEvent(event(message({ nonce: `${NONCE}x` })), expected), null);
  assert.equal(acceptBookmarkletEvent(event(message(), { source: {} }), expected), null);
  assert.equal(acceptBookmarkletEvent(event(message(), { origin: "https://evil.test" }), expected), null);
  assert.equal(acceptBookmarkletEvent(event(message(), { origin: "http://claude.ai" }), expected), null);
  assert.equal(acceptBookmarkletEvent(event(message()), { opener, nonce: null }), null);
  assert.equal(acceptBookmarkletEvent(event(message(), { source: null }), { opener: null, nonce: NONCE }), null);
  assert.equal(acceptBookmarkletEvent(event({ ...message(), type: "other" }), expected), null);
  // Ours, but not takeable: a page of another origin, empty, oversize, malformed.
  const status = (data: unknown) => acceptBookmarkletEvent(event(data), expected);
  assert.deepEqual(status(message({ source: source({ url: "https://chatgpt.com/c/1" }) })), { status: "rejected", reason: "invalid" });
  assert.deepEqual(status(message({ source: source({ text: "  " }) })), { status: "rejected", reason: "invalid" });
  assert.deepEqual(status(message({ source: source({ kind: "exe" }) })), { status: "rejected", reason: "invalid" });
  assert.deepEqual(status(message({ source: source({ text: "я".repeat(2_700_000) }) })), { status: "rejected", reason: "too_large" });
  assert.deepEqual(status({ type: BOOKMARKLET_MESSAGE, nonce: NONCE, failure: "sign_in" }), { status: "failure", failure: "sign_in" });
  assert.deepEqual(status({ type: BOOKMARKLET_MESSAGE, nonce: NONCE, failure: "rm -rf" }), { status: "rejected", reason: "invalid" });
  // Titles lose control and bidi characters and excess length.
  const titled = checkSource(source({ title: "a\u202eb\n c" + "x".repeat(300) }), CLAUDE);
  assert.ok(titled.status === "source");
  assert.equal(titled.source.title.slice(0, 5), "ab cx");
  assert.equal(titled.source.title.length, 160);
});

test("the bookmark takes replies only from its own Полка tab", () => {
  const tab = {};
  const expected = { tab, origin: "https://polochka.app", nonce: NONCE };
  const reply = { type: BOOKMARKLET_MESSAGE, nonce: NONCE, reply: "ready" };
  assert.equal(parseBookmarkletReply({ origin: "https://polochka.app", source: tab, data: reply }, expected)?.reply, "ready");
  assert.equal(parseBookmarkletReply({ origin: "https://evil.test", source: tab, data: reply }, expected), null);
  assert.equal(parseBookmarkletReply({ origin: "https://polochka.app", source: {}, data: reply }, expected), null);
  assert.equal(parseBookmarkletReply({ origin: "https://polochka.app", source: tab, data: { ...reply, nonce: "x" } }, expected), null);
});

test("nonce, sizes and the provenance address", () => {
  assert.equal(nonceFromHash(`#nonce=${NONCE}`), NONCE);
  assert.equal(nonceFromHash("#nonce=short"), null);
  assert.equal(nonceFromHash(""), null);
  assert.equal(utf8Bytes("aя€😀"), Buffer.byteLength("aя€😀"));
  assert.equal(provenanceUrl("https://claude.ai/chat/1?token=x#frag"), "https://claude.ai/chat/1");
  assert.equal(provenanceUrl("http://claude.ai/chat/1"), null);
  assert.equal(provenanceUrl("https://u:p@claude.ai/"), null);
});

test("an upload keeps a source address only for an HTML page, https and bare", () => {
  const base = {
    key: randomUUID(),
    title: "t",
    filename: "a.html",
    mime: "text/html",
    size: 10,
    sha256: "a".repeat(64),
  };
  assert.equal(beginUploadSchema.safeParse({ ...base, sourceUrl: "https://claude.ai/artifact/1" }).success, true);
  assert.equal(beginUploadSchema.safeParse(base).success, true);
  for (const sourceUrl of ["http://claude.ai/x", "https://claude.ai/x?a=1", "https://claude.ai/x#f", "https://u:p@claude.ai/", "javascript:alert(1)"])
    assert.equal(beginUploadSchema.safeParse({ ...base, sourceUrl }).success, false, sourceUrl);
  assert.equal(
    beginUploadSchema.safeParse({ ...base, mime: "text/plain", filename: "a.txt", sourceUrl: "https://claude.ai/x" }).success,
    false,
  );
});

test("the javascript: address carries the script intact, with the origin baked in", async () => {
  const script = await bookmarkletScript("https://polka.example");
  const href = javascriptUrl(script);
  assert.ok(href.startsWith("javascript:"));
  assert.doesNotMatch(href, /[\s#]|[^\x20-\x7e]/);
  assert.equal(decodeURIComponent(href.slice("javascript:".length)), script);
  assert.ok(script.includes('"https://polka.example"'));
  assert.ok(!script.includes(ORIGIN_PLACEHOLDER));
  // Nothing in it talks to a server: no fetch/XHR of its own, no storage.
  for (const forbidden of [/XMLHttpRequest/, /sendBeacon/, /document\.cookie/, /localStorage/, /\bsessionStorage\b/, /new WebSocket/])
    assert.doesNotMatch(script, forbidden);
  await assert.rejects(bookmarkletScript("https://polka.example/path"), /origin/i);
  // Small enough for a bookmark (browsers take far more; this is a budget).
  assert.ok(Buffer.byteLength(href) < 40 * 1024, `${Buffer.byteLength(href)} bytes`);
});

// --- The whole chain in a real Chrome ---------------------------------------

const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));
const openssl = spawnSync("openssl", ["version"]).status === 0;
const skip = !chromePath ? "Chrome is not installed here" : !openssl ? "openssl is not installed here" : false;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(probe: () => Promise<T>, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(100);
  }
}

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/extension/${name}`, import.meta.url), "utf8");
const ARTIFACT = `${CLAUDE}/artifact/0f6e1b2a`;

let app: any;
let db: any;
let s3: any;
let appOrigin = "";
let cookie: { name: string; value: string } | null = null;
let fixtures: HttpsServer | undefined;
let proxy: Server | undefined;
const refused: string[] = [];
// Chrome is killed at the end: its sockets reset. Every one is tracked and
// destroyed here, and their errors are expected, not failures.
const sockets = new Set<import("node:net").Socket>();
const track = (socket: import("node:net").Socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
};
let chrome: ChildProcess | undefined;
let scratch = "";
let socket: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, (message: any) => void>();
const events: any[] = [];

function send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, (message) =>
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result),
    );
    socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(sessionId: string, expression: string, userGesture = false) {
  const value = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture },
    sessionId,
  );
  if (value.exceptionDetails)
    throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result?.value;
}

async function attach(targetId: string) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  return sessionId as string;
}

async function openTab(url: string) {
  const { targetId } = await send("Target.createTarget", { url });
  const sessionId = await attach(targetId);
  await until(() => evaluate(sessionId, "document.readyState === 'complete' && location.href"), url);
  return { targetId, sessionId };
}

/** The tab a page opened with window.open (its opener is `openerId`). */
async function openedBy(openerId: string, seen: Set<string>) {
  const target = await until(async () => {
    const { targetInfos } = await send("Target.getTargets");
    return targetInfos.find(
      (info: any) => info.type === "page" && info.openerId === openerId && !seen.has(info.targetId),
    );
  }, "the Полка tab");
  seen.add(target.targetId);
  return { targetId: target.targetId as string, sessionId: await attach(target.targetId) };
}

const text = (sessionId: string) => evaluate(sessionId, "document.body ? document.body.innerText : ''");

before(async () => {
  if (skip) return;
  ({ db } = await import("../apps/server/db.ts"));
  ({ s3 } = await import("../apps/server/storage.ts"));
  const { config } = await import("../apps/server/config.ts");
  const { createApp } = await import("../apps/server/app.ts");
  const { registerFrontend } = await import("../apps/server/frontend.ts");
  const { createAccount } = await import("../apps/server/auth.ts");
  appOrigin = config.APP_ORIGIN;
  scratch = mkdtempSync(path.join(tmpdir(), "polka-bookmarklet-"));

  // The web app as shipped, built into a scratch folder.
  const { build } = await import("vite");
  await build({
    configFile: path.resolve("apps/web/vite.config.ts"),
    logLevel: "silent",
    build: { outDir: path.join(scratch, "web"), emptyOutDir: true },
  });
  app = await createApp();
  await registerFrontend(app, path.join(scratch, "web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const appPort = (app.server.address() as { port: number }).port;

  const password = randomBytes(24).toString("hex");
  const account = await createAccount(`bm-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: appOrigin },
    payload: { name: account.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = { name: login.cookies[0].name, value: login.cookies[0].value };

  // HTTPS for claude.ai and evil.test, with a throwaway certificate.
  const key = path.join(scratch, "key.pem");
  const cert = path.join(scratch, "cert.pem");
  const made = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=claude.ai",
    "-addext", "subjectAltName=DNS:claude.ai,DNS:evil.test",
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  fixtures = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(req.url ?? "/", `https://${host}`);
    const page =
      host === "claude.ai" && url.pathname === "/artifact/0f6e1b2a"
        ? fixture("claude-artifact-page.html")
        : host === "claude.ai" || host === "evil.test"
          ? `<!doctype html><title>${host}</title><p>${host}</p>`
          : null;
    if (!page) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  });
  fixtures.on("connection", track);
  fixtures.on("secureConnection", track);
  fixtures.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => fixtures!.listen(0, "127.0.0.1", resolve));
  const fixturePort = (fixtures.address() as { port: number }).port;

  // The only way out of Chrome: APP_ORIGIN → this Полка, TLS to the fixtures.
  const appHost = new URL(appOrigin).host;
  proxy = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return void res.writeHead(400).end();
    }
    if (target.host !== appHost) {
      refused.push(target.host);
      return void res.writeHead(403).end();
    }
    req.on("error", () => {});
    res.on("error", () => {});
    const upstream = httpRequest(
      { host: "127.0.0.1", port: appPort, method: req.method, path: target.pathname + target.search, headers: req.headers },
      (answer) => {
        answer.on("error", () => res.destroy());
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });
  proxy.on("connection", track);
  proxy.on("clientError", (_error, socket) => socket.destroy());
  proxy.on("connect", (req, client, head) => {
    track(client as import("node:net").Socket);
    const host = (req.url ?? "").replace(/:443$/, "");
    if (host !== "claude.ai" && host !== "evil.test") {
      refused.push(host);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = netConnect(fixturePort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  const profile = path.join(scratch, "chrome");
  chrome = spawn(
    chromePath!,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=<-loopback>",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited: number | null = null;
  chrome.once("exit", (code) => (exited = code ?? -1));
  const endpoint = await until(async () => {
    if (exited !== null) throw new Error(`Chrome exited (${exited})`);
    const [port, route] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    return port && route ? `ws://127.0.0.1:${port}${route}` : undefined;
  }, "Chrome", 45_000);
  socket = new WebSocket(endpoint!);
  await new Promise((resolve, reject) => {
    socket!.addEventListener("open", resolve);
    socket!.addEventListener("error", reject);
  });
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)!(data);
      pending.delete(data.id);
    } else if (data.method) events.push(data);
  });
  // Downloads are refused and reported: none may begin.
  await send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
});

after(async () => {
  socket?.close();
  if (chrome) {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => chrome!.once("exit", resolve));
  }
  for (const socket of sockets) socket.destroy();
  proxy?.close();
  fixtures?.close();
  await app?.close();
  await db?.end();
  s3?.destroy();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const REMEMBER_ORIGINALS = `window.__originals = [
  URL.createObjectURL, HTMLAnchorElement.prototype.click,
  EventTarget.prototype.dispatchEvent, window.open,
  Object.getOwnPropertyDescriptor(navigator.clipboard || {}, "writeText"),
]; true`;
const ORIGINALS_BACK = `(() => {
  const now = [URL.createObjectURL, HTMLAnchorElement.prototype.click,
    EventTarget.prototype.dispatchEvent, window.open,
    Object.getOwnPropertyDescriptor(navigator.clipboard || {}, "writeText")];
  return now.every((value, index) => value === window.__originals[index]);
})()`;

test("claude.ai artifact → bookmark → Полка tab → sign in → saved with its source", { skip }, async () => {
  const href = javascriptUrl(await bookmarkletScript(appOrigin));
  const seen = new Set<string>();
  const claude = await openTab(ARTIFACT);
  assert.equal(await evaluate(claude.sessionId, "location.href"), ARTIFACT);
  await evaluate(claude.sessionId, REMEMBER_ORIGINALS);
  const expected = await evaluate(claude.sessionId, "SOURCE");

  // The click: the bookmark's address, run in the page as a bookmark runs.
  await evaluate(
    claude.sessionId,
    `(0, eval)(${JSON.stringify(decodeURIComponent(href.slice("javascript:".length)))}); true`,
    true,
  );
  const polka = await openedBy(claude.targetId, seen);
  await until(async () => (await text(polka.sessionId)).includes("Трекер привычек") || (await text(polka.sessionId)).includes("Войти, чтобы сохранить"), "the card");

  // A guest: asked to sign in; the data waits in this tab only, the nonce is off the address bar.
  const guest = await text(polka.sessionId);
  assert.match(guest, /claude\.ai/);
  assert.match(guest, /Войти, чтобы сохранить/);
  assert.equal(await evaluate(polka.sessionId, "location.hash"), "");
  assert.ok(await evaluate(polka.sessionId, "!!sessionStorage.getItem('polka.bookmarklet.pending')"));

  // The chat page is as it was: nothing downloaded, nothing left patched or open.
  await until(() => evaluate(claude.sessionId, "!('__polkaBookmarkletBusy' in window)"), "the bookmark to finish");
  assert.equal(await evaluate(claude.sessionId, "window.__downloadClicks"), 0);
  assert.equal(await evaluate(claude.sessionId, "window.__markdownCopied"), false);
  assert.equal(await evaluate(claude.sessionId, ORIGINALS_BACK), true);
  assert.equal(await evaluate(claude.sessionId, "document.querySelector('[role=menu]')"), null);
  assert.equal(await evaluate(claude.sessionId, "document.querySelector('[data-polka-menu],[data-polka-copy]')"), null);
  assert.equal(await evaluate(claude.sessionId, "location.href"), ARTIFACT);
  assert.equal(events.filter((item) => /download/i.test(item.method)).length, 0);

  // Signed in (the same browser session), back to the same tab: the card again.
  await send("Network.setCookie", { ...cookie!, url: appOrigin, path: "/" }, polka.sessionId);
  await send("Page.navigate", { url: `${appOrigin}/bring/receive` }, polka.sessionId);
  await until(() => evaluate(polka.sessionId, "document.querySelector('.receive-card input')?.value"), "the title field");
  assert.equal(await evaluate(polka.sessionId, "document.querySelector('.receive-card input').value"), "Трекер привычек");
  await evaluate(
    polka.sessionId,
    `[...document.querySelectorAll('.receive-card button')].find((b) => b.textContent.includes('Сохранить на полку')).click()`,
  );
  const workId = await until(
    () => evaluate(polka.sessionId, "(/^\\/works\\/([0-9a-f-]{36})$/.exec(location.pathname) || [])[1]"),
    "the work page",
    20_000,
  );
  // The work page's bar: «Поделиться» is an icon button on a narrow window, so find it by name.
  await until(
    () => evaluate(polka.sessionId, "!!document.querySelector('.work-bar button[aria-label=\"Поделиться\"]')"),
    "«Поделиться»",
  );
  assert.equal(await evaluate(polka.sessionId, "sessionStorage.getItem('polka.bookmarklet.pending')"), null);

  const work = await app.inject({
    method: "GET",
    url: `/api/artifacts/${workId}`,
    headers: { origin: appOrigin, cookie: `${cookie!.name}=${cookie!.value}` },
  });
  assert.equal(work.statusCode, 200, work.body);
  const saved = work.json();
  assert.equal(saved.title, "Трекер привычек");
  assert.equal(saved.revision.mime, "text/html");
  assert.equal(saved.revision.sha256, createHash("sha256").update(expected).digest("hex"));
  assert.equal(saved.revision.manifest.provenance.kind, "url");
  assert.equal(saved.revision.manifest.provenance.sourceUrl, ARTIFACT);
  assert.deepEqual(refused.filter((host) => /claude|evil/.test(host)), []);
});

test("forged messages are ignored: another nonce, another window, another origin", { skip }, async () => {
  const seen = new Set<string>();
  const nonce = randomBytes(18).toString("base64url");
  const claude = await openTab(`${CLAUDE}/chat-page`);
  const post = (title: string, withNonce = nonce, tab = "__tab") => `
    ${tab}.postMessage({ type: ${JSON.stringify(BOOKMARKLET_MESSAGE)}, nonce: ${JSON.stringify(withNonce)},
      source: { url: location.origin + "/artifact/1", title: ${JSON.stringify(title)}, kind: "artifact",
        language: "html", text: "<!doctype html><title>t</title><p>${title}</p>" } }, ${JSON.stringify(appOrigin)}); true`;
  await evaluate(
    claude.sessionId,
    `window.__replies = []; addEventListener("message", (e) => __replies.push(e.data && e.data.reply));
     window.__tab = window.open(${JSON.stringify(`${appOrigin}/bring/receive#nonce=${nonce}`)}); !!__tab`,
    true,
  );
  const polka = await openedBy(claude.targetId, seen);
  await until(async () => (await text(polka.sessionId)).includes("Ждём данные"), "the waiting tab");

  // 1. The opener, another nonce.
  await evaluate(claude.sessionId, post("Чужой nonce", randomBytes(18).toString("base64url")));
  // 2. The right nonce and origin, but from a frame, not the opener.
  await evaluate(
    claude.sessionId,
    `new Promise((resolve) => { const frame = document.createElement("iframe"); frame.src = "/frame";
       frame.onload = () => { frame.contentWindow.eval(${JSON.stringify(post("Не opener", nonce, "parent.__tab"))}); resolve(true); };
       document.body.append(frame); })`,
  );
  await wait(500);
  assert.match(await text(polka.sessionId), /Ждём данные/);
  assert.doesNotMatch(await text(polka.sessionId), /Чужой|Не opener/);
  assert.deepEqual(await evaluate(claude.sessionId, "__replies"), []);

  // The real one, from claude.ai, the opener, with this nonce: taken and answered.
  await evaluate(
    claude.sessionId,
    `window.__replies = []; ${post("Настоящий")}`,
  );
  await until(async () => (await text(polka.sessionId)).includes("Артефакт"), "the card");
  assert.deepEqual(await until(() => evaluate(claude.sessionId, "__replies.length && __replies"), "the reply"), ["ready"]);
  // Only the first accepted message counts.
  await evaluate(claude.sessionId, post("Второй"));
  await wait(300);
  assert.deepEqual(await evaluate(claude.sessionId, "__replies"), ["ready"]);
  // Signed in by the test before: the title field holds the real one.
  assert.equal(
    await until(() => evaluate(polka.sessionId, "document.querySelector('.receive-card input')?.value"), "the title"),
    "Настоящий",
  );

  // 3. Another site opens Полка with a nonce of its own and posts a well-formed
  // artifact (its own address, or claude.ai's): the origin is not an AI chat.
  const evil = await openTab("https://evil.test/");
  const evilNonce = randomBytes(18).toString("base64url");
  await evaluate(
    evil.sessionId,
    `window.__replies = []; addEventListener("message", (e) => __replies.push(e.data && e.data.reply));
     window.__tab = window.open(${JSON.stringify(`${appOrigin}/bring/receive#nonce=${evilNonce}`)}); !!__tab`,
    true,
  );
  const lured = await openedBy(evil.targetId, seen);
  await until(async () => (await text(lured.sessionId)).includes("Ждём данные"), "the lured tab");
  await evaluate(evil.sessionId, post("Чужой сайт", evilNonce));
  await evaluate(evil.sessionId, post("Чужой сайт", evilNonce).replace("location.origin", JSON.stringify(CLAUDE)));
  await wait(800);
  assert.match(await text(lured.sessionId), /Ждём данные/);
  assert.doesNotMatch(await text(lured.sessionId), /Чужой/);
  assert.deepEqual(await evaluate(evil.sessionId, "__replies"), []);
});

test("on a site that is not an AI chat the bookmark opens nothing", { skip }, async () => {
  const href = javascriptUrl(await bookmarkletScript(appOrigin));
  const evil = await openTab("https://evil.test/");
  const before = (await send("Target.getTargets")).targetInfos.length;
  await evaluate(evil.sessionId, `(0, eval)(${JSON.stringify(decodeURIComponent(href.slice("javascript:".length)))}); true`, true);
  await wait(500);
  assert.equal((await send("Target.getTargets")).targetInfos.length, before);
  assert.equal(await evaluate(evil.sessionId, "!!document.getElementById('polka-bookmarklet-toast')"), true);
});

test("/bookmarklet hands out this Полка's bookmark as a real javascript: link", { skip }, async () => {
  const page = await openTab(`${appOrigin}/bookmarklet`);
  const href = await until(
    () => evaluate(page.sessionId, "document.querySelector('.bookmarklet-button')?.getAttribute('href')"),
    "the bookmark link",
  );
  assert.ok(href.startsWith("javascript:"));
  assert.ok(decodeURIComponent(href).includes(JSON.stringify(appOrigin)));
  assert.ok(!href.includes(ORIGIN_PLACEHOLDER));
  assert.equal(href, javascriptUrl(await bookmarkletScript(appOrigin)));
  // A click on Полка itself does nothing but explain.
  await evaluate(page.sessionId, "document.querySelector('.bookmarklet-button').click()");
  assert.equal(await evaluate(page.sessionId, "location.pathname"), "/bookmarklet");
  assert.match(await text(page.sessionId), /Перетащите кнопку мышью/);
  // Opened by hand, /bring/receive explains itself.
  const receive = await openTab(`${appOrigin}/bring/receive`);
  await until(async () => (await text(receive.sessionId)).includes("Установить закладку"), "the explanation");
});
