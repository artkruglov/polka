import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compactNumber,
  formatCost,
  formatDuration,
  listQuery,
  secretFlags,
  type AgentSession,
  type SessionStats,
} from "../apps/web/src/entities/agent-session/model.ts";
import { WorkSessionsList } from "../apps/web/src/entities/agent-session/WorkSessions.tsx";
import {
  AlertList,
  FingerprintTable,
  LinkList,
  SecretsTable,
  SessionRow,
  SessionsOff,
  SessionsStart,
  SessionsTabs,
  ToolCallList,
  TranscriptEvents,
  UsageView,
  CALLS_SHOWN,
  setupCommands,
  sessionsRoute,
} from "../apps/web/src/pages/sessions/parts.tsx";
import { isAppPage } from "../packages/contracts/app-routes.ts";
import { routeTitle } from "../apps/web/src/app/routing/titles.ts";

const id = "0b5f2a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const session: AgentSession = {
  id,
  source: "claude-code",
  externalId: "abc",
  projectLabel: "demo-app",
  projectRemote: null,
  gitBranch: "main",
  cliVersion: "2.1.0",
  permissionMode: "bypassPermissions",
  startedAt: "2026-10-07T10:00:00.000Z",
  endedAt: "2026-10-07T11:30:00.000Z",
  turns: 3,
  prompts: 3,
  toolCallCount: 5,
  tokens: { input: 100, output: 12_345, cacheRead: 2_000_000, cacheWrite: 0 },
  models: {},
  costUSD: 1.5,
  costEstimated: true,
  secretsStatus: "sent_out",
  alerts: [{ rule: "destructive_command", count: 2, firstSeq: 1 }],
  transcriptBytes: 1000,
  uploadedAt: "2026-10-07T12:00:00.000Z",
  updatedAt: "2026-10-07T12:00:00.000Z",
};

test("routes: the list, «Секреты», «Расход» and one session are app pages with titles", () => {
  for (const path of ["/sessions", "/sessions/secrets", "/sessions/usage", `/sessions/${id}`]) {
    assert.ok(isAppPage(path), path);
    assert.ok(routeTitle(path), path);
  }
  assert.ok(!isAppPage("/sessions/whatever"));
  assert.deepEqual(sessionsRoute(`/sessions/${id}`), { view: "session", id });
  assert.deepEqual(sessionsRoute("/sessions/usage"), { view: "usage" });
  assert.deepEqual(sessionsRoute("/sessions"), { view: "list" });
});

test("formatting and filters", () => {
  assert.equal(listQuery({ source: "codex", project: "", secrets: "any", alerts: "" }, null, 50), "source=codex&secrets=any&limit=50");
  assert.equal(formatCost(null), "—");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatDuration(90 * 60_000), "1 ч 30 мин");
  assert.equal(compactNumber(2_000_000), "2 млн");
  assert.deepEqual(secretFlags({ seenByModel: true, modelEmitted: true, toCommand: true, toNetwork: true, writtenToFile: false }), [
    "отправлен в сеть",
    "в команде",
    "модель видела",
  ]);
});

test("a session row shows facts, the secrets status and alerts; never more than the server gave", () => {
  const row = html(React.createElement(SessionRow, { session }));
  assert.match(row, new RegExp(`href="/sessions/${id}"`));
  assert.match(row, /demo-app/);
  assert.match(row, /Claude Code · main/);
  assert.match(row, /секрет отправлен наружу/);
  assert.match(row, /Разрушительная команда/);
  assert.match(row, /\$1\.50 \(оценка\)/);
  const alerts = html(React.createElement(AlertList, { alerts: session.alerts }));
  assert.match(alerts, /href="#call-1"/);
});

test("secrets show type, fingerprint and where they went, never a value", () => {
  const table = html(
    React.createElement(SecretsTable, {
      secrets: [
        { fingerprint: "a1b2c3d4e5f6", type: "github-token", confidence: "high", prefix: "ghp_", length: 40, occurrences: 2, seenByModel: true, modelEmitted: true, toCommand: false, toNetwork: true, writtenToFile: false, sessions: 3 },
      ],
    }),
  );
  assert.match(table, /github-token/);
  assert.match(table, /a1b2c3d4e5f6/);
  assert.match(table, /ghp_…/);
  assert.match(table, /отправлен в сеть/);
  assert.match(table, /sessions-danger/);
  assert.match(html(React.createElement(SecretsTable, { secrets: [] })), /не найдено/);
  const fingerprints = html(
    React.createElement(FingerprintTable, {
      fingerprints: [{ fingerprint: "ffffeeeedddd", type: "assignment", prefix: null, sessions: 4, occurrences: 9, toNetwork: false, toCommand: true, writtenToFile: false, seenByModel: true, lastSeen: session.startedAt, lastSessionId: id }],
    }),
  );
  assert.match(fingerprints, new RegExp(`/sessions/${id}`));
  assert.match(fingerprints, /в команде/);
});

test("links to works stay on the shelf, pull requests open safely", () => {
  const links = html(
    React.createElement(LinkList, {
      links: [
        { kind: "work", target: id, artifactId: id, title: "Отчёт" },
        { kind: "pr", target: "https://github.com/example/demo/pull/7", artifactId: null, title: null },
      ],
    }),
  );
  assert.match(links, new RegExp(`href="/works/${id}"`));
  assert.match(links, /rel="noopener noreferrer"/);
  assert.match(links, /github\.com\/example\/demo\/pull\/7/);
});

test("the timeline is cut to the first calls until asked; the transcript renders text as text", () => {
  const calls = Array.from({ length: CALLS_SHOWN + 5 }, (_, seq) => ({
    seq,
    at: null,
    tool: "Bash",
    kind: "shell" as const,
    mcpServer: null,
    status: seq === 0 ? ("error" as const) : ("ok" as const),
    durationMs: 1200,
    exitCode: seq === 0 ? 1 : 0,
    inputBytes: 10,
    outputBytes: 10,
    argv0: "git",
    template: "git push --force origin",
    hosts: seq === 0 ? ["github.com"] : [],
    network: seq === 0,
    subagent: false,
  }));
  const list = html(React.createElement(ToolCallList, { calls }));
  assert.equal((list.match(/<li /g) ?? []).length, CALLS_SHOWN);
  assert.match(list, /Показать все 205/);
  assert.match(list, /код 1/);
  assert.match(list, /→ github\.com/);
  const transcript = html(
    React.createElement(TranscriptEvents, {
      events: [
        { type: "prompt", text: "<script>alert(1)</script>" },
        { type: "tool_call", tool: "Bash", input: "{\"command\":\"ls\"}" },
      ],
    }),
  );
  assert.ok(!transcript.includes("<script>"));
  assert.match(transcript, /Вызов · Bash/);
});

test("the empty states say how to turn sessions on and how to send the first ones", () => {
  assert.match(html(React.createElement(SessionsOff)), /POLKA_SESSIONS=on/);
  const start = html(React.createElement(SessionsStart, { origin: "https://polochka.app" }));
  assert.match(start, /https:\/\/polochka\.app\/api\/v1\/cli\/polka-sessions\.mjs/);
  assert.match(start, /sync --since 7d/);
  assert.equal(setupCommands("https://x.test").login, "pbpaste | node polka-sessions.mjs login");
  const tabs = html(React.createElement(SessionsTabs, { current: "secrets" }));
  assert.match(tabs, /href="\/sessions\/secrets" aria-current="page"/);
});

test("«Расход» and «Сделано в сессии»", () => {
  const stats: SessionStats = {
    days: 30,
    totals: { sessions: 2, toolCalls: 40, cost: 3.25, withoutCost: 1, someEstimated: false },
    byDay: [{ day: "2026-10-07", sessions: 2, toolCalls: 40, input: 10, output: 500, cacheRead: 0, cost: 3.25 }],
    byModel: [{ model: "gpt-5.5", sessions: 1, input: 10, output: 500, cacheRead: 0, cacheWrite: 0 }],
    secrets: { clean: 1, sent_out: 1 },
    fingerprints: [],
    hosts: [{ host: "api.example.org", calls: 3, sessions: 1 }],
    mcp: [{ server: "polka", calls: 2, errors: 1 }],
    alerts: [{ rule: "pipe_to_shell", sessions: 1, count: 1 }],
  };
  const usage = html(React.createElement(UsageView, { stats }));
  assert.match(usage, /gpt-5\.5/);
  assert.match(usage, /api\.example\.org/);
  assert.match(usage, /ошибок: 1/);
  assert.match(usage, /без цены: 1 сессия/);
  assert.match(usage, /Скрипт из сети в оболочку/);
  assert.equal(html(React.createElement(WorkSessionsList, { sessions: [] })), "");
  const linked = html(React.createElement(WorkSessionsList, { sessions: [{ id, source: "codex", projectLabel: "api", startedAt: session.startedAt, secretsStatus: "clean" }] }));
  assert.match(linked, /Сделано в сессии/);
  assert.match(linked, new RegExp(`href="/sessions/${id}"`));
});
