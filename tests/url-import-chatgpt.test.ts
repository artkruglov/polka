// ChatGPT share and canvas pages (apps/server/url-import/providers/chatgpt.ts).
// The fixtures are synthetic but shaped like the real pages (checked on
// 2026-09-24): React Router loader data in a turbo-stream inside
// `window.__reactRouterContext.streamController.enqueue("…")`, a share under
// routes/share.$shareId.($action).serverResponse.data.linear_conversation, a
// canvas under routes/canvas.shared.$sharedTextdocId.sharedTextdoc. The page
// comes from the renderer's /fetch, a stand-in here: nothing leaves the test.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  captureChatgpt,
  chatgptWork,
  codeBlocks,
  parseChatgpt,
  turboStreamRoot,
} from "../apps/server/url-import/providers/chatgpt.ts";
import { validateAgentCapture } from "../apps/server/agent-capture.ts";
import type { FetchResult } from "../packages/renderer-contract.ts";

/** Encodes a value the way turbo-stream does: a flat array, objects as {"_<key index>": <value index>}, null as -5. */
function turboStream(value: unknown): string {
  const flat: unknown[] = [];
  const strings = new Map<string, number>();
  const put = (item: unknown): number => {
    if (item === null) return -5;
    if (item === undefined) return -7;
    if (typeof item === "string") {
      const known = strings.get(item);
      if (known !== undefined) return known;
      flat.push(item);
      strings.set(item, flat.length - 1);
      return flat.length - 1;
    }
    if (typeof item !== "object") {
      flat.push(item);
      return flat.length - 1;
    }
    const index = flat.length;
    flat.push(null);
    if (Array.isArray(item)) flat[index] = item.map(put);
    else {
      const out: Record<string, number> = {};
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) out[`_${put(key)}`] = put(child);
      flat[index] = out;
    }
    return index;
  };
  put(value);
  return JSON.stringify(flat);
}

function page(title: string, loaderData: Record<string, unknown>) {
  const stream = turboStream({ loaderData, actionData: null, errors: null });
  return `<!doctype html><html><head><title>ChatGPT - ${title}</title></head><body><div id="root"></div>
<script>window.__reactRouterContext = {"basename":"/"};</script>
<script nonce="x">window.__reactRouterContext.streamController.enqueue(${JSON.stringify(stream)});</script>
<script nonce="x">window.__reactRouterContext.streamController.enqueue("P288:[{}]\\n");</script>
</body></html>`;
}

const message = (role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  message: {
    id: randomUUID(),
    author: { role, name: null, metadata: {} },
    content: { content_type: "text", parts: [text] },
    metadata: {},
    recipient: "all",
    ...extra,
  },
  children: [],
});

function share(title: string, nodes: unknown[]) {
  return page(title, {
    root: { dd: {}, disableSSR: false },
    "routes/share.$shareId.($action)": {
      sharedConversationId: "68063082-c2d8-8012-8d45-fa674aa1c1ed",
      serverResponse: { type: "data", data: { title, linear_conversation: [{ id: "client-created-root", children: [] }, ...nodes], is_public: true } },
      meta: { pageTitle: title },
    },
  });
}

const SHARE = "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed";
const CANVAS = "https://chatgpt.com/canvas/shared/68d0334db1c08191b91094c29bee3c78";
const HTML_APP = "<!doctype html>\n<html><head><title>Timer</title><style>h1{color:teal}</style></head><body><h1>Pomodoro</h1><script>let t=25</script></body></html>";

test("turbo-stream: objects, arrays, shared strings and null come back as plain values", () => {
  const root = turboStreamRoot(page("x", { a: { list: ["one", "two", "one"], none: null, n: 3, yes: true } })) as any;
  assert.deepEqual(root.loaderData.a, { list: ["one", "two", "one"], none: null, n: 3, yes: true });
  assert.equal(turboStreamRoot("<html>no stream</html>"), null);
});

test("a share with an HTML page in the last reply becomes that page", () => {
  const html = share("Pomodoro timer", [
    message("system", "", { metadata: { is_visually_hidden_from_conversation: true } }),
    message("user", "Make me a pomodoro timer page"),
    message("assistant", "print('draft')", { recipient: "python" }),
    message("tool", "output redacted"),
    message("assistant", `Here it is:\n\n\`\`\`html\n${HTML_APP}\n\`\`\`\n\nOpen it in a browser.`),
  ]);
  const content = parseChatgpt(html);
  assert.equal(content.title, "Pomodoro timer");
  assert.deepEqual(content.messages.map((m) => m.role), ["user", "assistant"], "hidden, tool and python messages are left out");
  const work = chatgptWork(content);
  assert.equal(work.what, "code");
  assert.deepEqual(work.body, { html: `${HTML_APP}\n` });
});

test("a React component in the reply is a component; the last page-like block wins", () => {
  const component = `import React, { useState } from "react";\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}\n`;
  const content = parseChatgpt(
    share("Counter", [
      message("user", "counter"),
      message("assistant", `Install:\n\`\`\`bash\nnpm i react\n\`\`\`\nComponent:\n\`\`\`jsx\n${component}\`\`\`\nAnd a python helper:\n\`\`\`python\nprint(1)\n\`\`\``),
    ]),
  );
  const work = chatgptWork(content);
  assert.equal(work.what, "code");
  assert.ok("component" in work.body && work.body.componentLanguage === "jsx");
  assert.equal(codeBlocks("```js\na\n```\ntext\n~~~\nb\n~~~").length, 2);
});

test("a share without a page or component is saved as the conversation text", () => {
  const work = chatgptWork(
    parseChatgpt(share("Python Beginner Guide", [message("user", "Explain <loops>"), message("assistant", "Use `for x in y:`\n```python\nfor i in range(3): print(i)\n```")])),
  );
  assert.equal(work.what, "conversation");
  assert.ok("html" in work.body);
  const html = (work.body as { html: string }).html;
  assert.match(html, /Explain &lt;loops&gt;/);
  assert.match(html, /Пользователь/);
  assert.doesNotMatch(html, /<script/);
});

test("a canvas: shared textdoc pages and components, and a canvas created in a conversation", () => {
  const react = `import React from "react";\nexport default function Site() {\n  return (<div className="p-4">Hello</div>);\n}\n`;
  const canvas = parseChatgpt(
    page("Site", {
      root: {},
      "routes/canvas.shared.$sharedTextdocId": {
        sharedTextdoc: { sharedTextdocId: "68d0334db1c08191b91094c29bee3c78", versionInt: null, title: "Site", type: "code/react", content: react, access: "public" },
        isAuthenticated: false,
      },
    }),
  );
  assert.equal(canvas.canvas?.type, "code/react");
  const work = chatgptWork(canvas);
  assert.equal(work.what, "canvas");
  assert.ok("component" in work.body);
  const doc = chatgptWork(
    parseChatgpt(
      page("Notes", { "routes/canvas.shared.$sharedTextdocId": { sharedTextdoc: { title: "Notes", type: "document", content: "# Plan\n\n- one" } } }),
    ),
  );
  assert.ok("html" in doc.body && /<pre># Plan/.test(doc.body.html));
  // canmore: the model created a canvas inside the conversation.
  const created = parseChatgpt(
    share("Landing", [
      message("user", "landing page"),
      message("assistant", "", {
        recipient: "canmore.create_textdoc",
        content: { content_type: "code", language: "json", text: JSON.stringify({ name: "Landing", type: "code/html", content: HTML_APP }) },
      }),
      message("assistant", "I created the landing page in the canvas."),
    ]),
  );
  assert.equal(chatgptWork(created).what, "canvas");
  // An update is a patch this page cannot replay: the conversation is kept instead of a stale canvas.
  const updated = parseChatgpt(
    share("Landing", [
      message("assistant", "", { recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "L", type: "code/html", content: HTML_APP }) } }),
      message("assistant", "", { recipient: "canmore.update_textdoc", content: { content_type: "code", text: "{}" } }),
      message("assistant", "Updated."),
    ]),
  );
  assert.equal(updated.canvas, null);
});

test("an unknown page is refused, not saved as an empty chat", () => {
  assert.throws(() => parseChatgpt("<!doctype html><title>ChatGPT</title><p>Log in</p>"), { code: "unsupported_type" });
  assert.throws(() => parseChatgpt(page("x", { root: {} })), { code: "unsupported_type" });
});

test("capture: one /fetch through the renderer, no request to chatgpt.com from the app, errors mapped", async () => {
  const asked: string[] = [];
  const fetch = (result: FetchResult) => async (url: string) => {
    asked.push(url);
    return result;
  };
  const fetcher = async (url: string) => {
    throw Error(`the app must not download ${url}`);
  };
  const html = share("Pomodoro timer", [message("user", "timer"), message("assistant", `\`\`\`html\n${HTML_APP}\n\`\`\``)]);
  const result = await captureChatgpt(SHARE, { fetch: fetch({ finalUrl: SHARE, status: 200, html }), fetcher });
  assert.deepEqual(asked, [SHARE]);
  assert.equal(result.title, "Pomodoro timer");
  assert.equal(result.manifest.provenance.sourceUrl, SHARE);
  assert.ok(result.warnings.some((w) => /последнего ответа/.test(w)));
  const parsed = validateAgentCapture({ key: randomUUID(), title: result.title, manifest: result.manifest, files: result.files }, "capture");
  assert.match(parsed.source.get("index.html")!.toString(), /Pomodoro/);
  await assert.rejects(captureChatgpt(SHARE, { fetch: fetch({ error: "robots_disallowed" }), fetcher }), { code: "robots_disallowed" });
  await assert.rejects(captureChatgpt(SHARE, { fetch: fetch({ error: "source_blocked", detail: "cloudflare_challenge" }), fetcher }), { code: "source_blocked" });
  await assert.rejects(
    captureChatgpt(SHARE, {
      fetch: async () => {
        throw Error("ECONNREFUSED");
      },
      fetcher,
    }),
    { code: "renderer_unavailable" },
  );
  await assert.rejects(captureChatgpt("https://chatgpt.com/c/68063082-c2d8-8012-8d45-fa674aa1c1ed", { fetch: fetch({ error: "busy" }), fetcher }), {
    code: "not_allowed",
  });
  // One request per attempt (the refusing stand-in and the /c/ link, never sent, are not counted).
  assert.equal(asked.length, 3, "one request per attempt, never a retry");
  const canvas = await captureChatgpt(CANVAS, {
    fetch: fetch({
      finalUrl: CANVAS,
      status: 200,
      html: page("Doc", { "routes/canvas.shared.$sharedTextdocId": { sharedTextdoc: { title: "Doc", type: "code/html", content: HTML_APP } } }),
    }),
    fetcher,
  });
  assert.equal(canvas.title, "Doc");
});
