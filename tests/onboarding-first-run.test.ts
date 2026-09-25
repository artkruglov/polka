import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentConnection,
  Artifact,
  Revision,
} from "../packages/contracts/index.ts";
import { looksLikeHtml, MAX_BYTES } from "../packages/contracts/index.ts";
import { classifyHtml } from "../apps/server/html.ts";
import { connectGuide } from "../apps/server/connect-guide.ts";
import { deriveFirstRun } from "../apps/web/src/entities/onboarding/steps.ts";
import {
  dismissalKey,
  readDismissed,
  writeDismissed,
} from "../apps/web/src/entities/onboarding/dismissal.ts";
import {
  SAMPLE_TITLE,
  samplePage,
} from "../apps/web/src/entities/onboarding/sample-page.ts";
import {
  clientHints,
  connectPhrase,
} from "../apps/web/src/entities/onboarding/connect-phrase.ts";
import { FirstRunSteps } from "../apps/web/src/features/first-run/index.tsx";

const revision: Revision = {
  id: "r1",
  number: 1,
  filename: "report.html",
  mime: "text/html",
  size: 120,
  totalSize: 120,
  sha256: "a".repeat(64),
  storageKind: "single",
  htmlProfile: "static",
  inlineBuild: null,
  createdAt: "2026-09-20T10:00:00Z",
};
const work = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  title: "Отчёт",
  folderId: null,
  updatedAt: "2026-09-21T10:00:00Z",
  trashedAt: null,
  lifecycleVersion: 1,
  revision,
  share: null,
  ...over,
});
const connection = (over: Partial<AgentConnection> = {}): AgentConnection => ({
  id: "c1",
  name: "Codex CLI",
  scopes: ["context", "capture"],
  audience: "http://127.0.0.1:4390/mcp",
  status: "issued",
  kind: "oauth",
  createdAt: "2026-09-21T10:00:00Z",
  expiresAt: "2026-10-21T10:00:00Z",
  lastSeenAt: null,
  ...over,
});

test("an empty shelf without connections has three pending steps, the agent first", () => {
  const model = deriveFirstRun({ connections: [], works: [] });
  assert.deepEqual(
    model.steps.map((s) => [s.id, s.done]),
    [["agent", false], ["save", false], ["share", false]],
  );
  assert.equal(model.done, 0);
  assert.equal(model.next, "agent");
  assert.equal(model.complete, false);
  assert.equal(model.shareTarget, null);
  assert.equal(model.agentSaved, false);
});

test("only an issued or seen connection counts as connected; a used one is preferred", () => {
  assert.equal(
    deriveFirstRun({
      connections: [connection({ status: "revoked" }), connection({ status: "expired" })],
      works: [],
    }).steps[0].done,
    false,
  );
  const issued = deriveFirstRun({ connections: [connection()], works: [] });
  assert.equal(issued.steps[0].done, true);
  assert.match(issued.steps[0].note!, /Codex CLI · доступ выдан/);
  const seen = deriveFirstRun({
    connections: [
      connection({ id: "old", name: "Старый", status: "issued" }),
      connection({ id: "new", name: "Claude Code", status: "seen", lastSeenAt: "2026-09-22T09:00:00Z" }),
    ],
    works: [],
  });
  assert.match(seen.steps[0].note!, /^Claude Code · обращался к Полке/);
  assert.equal(seen.next, "save");
});

test("the first work completes the save step and becomes the share target", () => {
  const model = deriveFirstRun({ connections: [], works: [work()] });
  assert.equal(model.steps[1].done, true);
  assert.match(model.steps[1].note!, /Отчёт · v1/);
  assert.equal(model.steps[2].done, false);
  assert.equal(model.shareTarget?.id, "a1");
  assert.equal(model.next, "agent");
});

test("a work that cannot open by link is not offered for sharing; the note says why", () => {
  const model = deriveFirstRun({
    connections: [],
    works: [work({ revision: { ...revision, htmlProfile: "unsupported" } })],
  });
  assert.equal(model.shareTarget, null);
  assert.match(model.steps[2].note!, /нельзя отправить ссылкой/);
  const mixed = deriveFirstRun({
    connections: [],
    works: [
      work({ id: "bad", revision: { ...revision, htmlProfile: "unsupported" } }),
      work({ id: "img", revision: { ...revision, mime: "image/png", htmlProfile: null } }),
    ],
  });
  assert.equal(mixed.shareTarget?.id, "img");
});

test("any share ever created completes the link step; the note reflects its status", () => {
  const active = deriveFirstRun({
    connections: [],
    works: [
      work({
        share: { id: "s", revisionId: "r1", number: 1, status: "active", url: "http://x/s#t", expiresAt: "2026-10-01T00:00:00Z" },
      }),
    ],
  });
  assert.equal(active.steps[2].done, true);
  assert.match(active.steps[2].note!, /действует до 1 октября/);
  assert.equal(active.shareTarget, null);
  const revoked = deriveFirstRun({
    connections: [],
    works: [
      work({
        share: { id: "s", revisionId: "r1", number: 1, status: "revoked", url: null, expiresAt: "2026-10-01T00:00:00Z" },
      }),
    ],
  });
  assert.equal(revoked.steps[2].done, true);
  assert.match(revoked.steps[2].note!, /закрыта/);
});

test("everything done: complete, no next step, and a used connection with works means the agent saved", () => {
  const model = deriveFirstRun({
    connections: [connection({ status: "seen", lastSeenAt: "2026-09-22T09:00:00Z" })],
    works: [
      work({
        share: { id: "s", revisionId: "r1", number: 1, status: "behind", url: "http://x/s#t", expiresAt: "2026-10-01T00:00:00Z" },
      }),
    ],
  });
  assert.equal(model.done, 3);
  assert.equal(model.complete, true);
  assert.equal(model.next, null);
  assert.equal(model.agentSaved, true);
});

test("the dismissal is per account and survives a storage that throws", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  };
  assert.equal(readDismissed("u1", storage), false);
  assert.equal(writeDismissed("u1", true, storage), true);
  assert.equal(readDismissed("u1", storage), true);
  assert.equal(readDismissed("u2", storage), false);
  assert.equal(memory.has(dismissalKey("u1")), true);
  assert.equal(writeDismissed("u1", false, storage), true);
  assert.equal(readDismissed("u1", storage), false);
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readDismissed("u1", broken), false);
  assert.equal(writeDismissed("u1", true, broken), false);
  assert.equal(readDismissed("u1", null), false);
  assert.equal(writeDismissed("u1", true, null), false);
});

test("the built-in example is a small self-contained static page the server can link", () => {
  const html = samplePage();
  assert.ok(looksLikeHtml(html));
  assert.equal(classifyHtml(html), "static");
  assert.ok(Buffer.byteLength(html) < 16 * 1024);
  assert.ok(Buffer.byteLength(html) < MAX_BYTES);
  assert.match(html, new RegExp(`<title>${SAMPLE_TITLE}</title>`));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script|<form|<iframe/i);
});

test("the phrase and the client hints match what GET /connect tells the agent", () => {
  const origin = "https://polochka.app";
  const guide = connectGuide(origin);
  assert.equal(connectPhrase(origin), `Подключи Полку: ${origin}/connect`);
  const hints = clientHints(origin);
  assert.equal(hints.length, 4);
  for (const hint of hints) {
    if (hint.command) assert.ok(guide.includes(hint.command), `guide lacks ${hint.command}`);
    assert.ok(hint.note.includes("/mcp") || hint.command, `${hint.id} names the MCP address`);
  }
  assert.ok(guide.includes("Settings → Connectors → Add custom connector"));
  assert.ok(guide.includes("Developer mode → Create"));
});

function markup(
  model: ReturnType<typeof deriveFirstRun>,
  over: Partial<Parameters<typeof FirstRunSteps>[0]> = {},
) {
  return renderToStaticMarkup(
    React.createElement(FirstRunSteps, {
      model,
      origin: "https://polochka.app",
      variant: "card",
      connections: { status: "ready", retry: () => {} },
      works: { status: "ready", retry: () => {} },
      sample: { busy: false, stage: "", error: "", retrying: false, saved: null, save: () => {} },
      announcement: "",
      client: "claude-code",
      onClient: () => {},
      onDismiss: () => {},
      ...over,
    }),
  );
}

test("the checklist shows the phrase, marks the current step and keeps a live region", () => {
  const html = markup(deriveFirstRun({ connections: [], works: [] }));
  assert.match(html, /aria-labelledby="first-run-title"/);
  assert.match(html, /0 из 3/);
  assert.match(html, /Подключи Полку: https:\/\/polochka.app\/connect/);
  assert.match(html, /Скопировать фразу/);
  assert.match(html, /aria-current="step"[^>]*>[\s\S]*?Подключите агента/);
  assert.match(html, /codex plugin marketplace add artkruglov\/polka &amp;&amp; codex plugin add polka@polka/);
  assert.match(html, /href="\/bring"[^>]*>[\s\S]*?Загрузить файл/);
  assert.match(html, /Сохранить пример/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /Скрыть/);
  assert.doesNotMatch(html, /Поделиться/);
});

test("a done step is announced as done and the share step links the first work", () => {
  const html = markup(
    deriveFirstRun({ connections: [connection({ status: "seen" })], works: [work()] }),
    { announcement: "Шаг выполнен: Сохраните первые работы. 2 из 3." },
  );
  assert.match(html, /2 из 3/);
  assert.match(html, /Выполнено: <\/span>Подключите агента/);
  assert.match(html, /href="\/works\/a1\?panel=share"/);
  assert.match(html, /Агент подключён и уже обращался к Полке/);
  assert.doesNotMatch(html, /Скопировать фразу|Сохранить пример/);
  assert.match(html, /Шаг выполнен: Сохраните первые работы\. 2 из 3\./);
});

test("the page variant has no dismiss button and the complete state says what comes next", () => {
  const html = markup(
    deriveFirstRun({
      connections: [connection()],
      works: [
        work({
          share: { id: "s", revisionId: "r1", number: 1, status: "active", url: "http://x/s#t", expiresAt: "2026-10-01T00:00:00Z" },
        }),
      ],
    }),
    { variant: "page" },
  );
  assert.match(html, /Готово: агент, работа, ссылка/);
  assert.match(html, /3 из 3/);
  assert.doesNotMatch(html, />Скрыть</);
  assert.match(html, /Дальше просто просите агента/);
});
