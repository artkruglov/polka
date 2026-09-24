import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AGENT_CLIENT_IDS,
  CLIENT_STORAGE_KEY,
  SAVE_PHRASE,
  agentClients,
  clientSetup,
  isFreshAccount,
  parseClientId,
  readStoredClient,
  relativeTime,
  signInMethod,
  signInMethodLabel,
  storeClient,
} from "../apps/web/src/entities/onboarding/agent-setup.ts";
import { connectPhrase } from "../apps/web/src/entities/onboarding/connect-phrase.ts";
import {
  SetupPanel,
  connectionStatus,
} from "../apps/web/src/pages/agents/index.tsx";
import { connectGuide } from "../apps/server/connect-guide.ts";
import { llmsText, skillMarkdown } from "../apps/server/agent-discovery.ts";
import type { AgentConnection } from "../packages/contracts/index.ts";

const origin = "https://polochka.app";

test("every client has a card and a panel; the commands are the ones /connect gives the agent", () => {
  const guide = connectGuide(origin);
  assert.deepEqual(
    agentClients.map((card) => card.id),
    [...AGENT_CLIENT_IDS],
  );
  for (const id of AGENT_CLIENT_IDS) {
    const setup = clientSetup(origin, id);
    assert.equal(setup.id, id);
    assert.ok(setup.steps.length >= 3, `${id} has numbered steps`);
    const copies = setup.steps.flatMap((step) => step.copies ?? []);
    assert.ok(copies.length >= 1, `${id} has something to copy`);
    for (const copy of copies) {
      if (copy.kind === "command")
        assert.ok(guide.includes(copy.value), `guide lacks ${copy.value}`);
      if (copy.kind === "url") assert.equal(copy.value, `${origin}/mcp`);
    }
    // Every panel ends with the phrase the person says afterwards, or says where the token is.
    const text = setup.steps.map((step) => step.text).join(" ");
    assert.ok(
      text.includes(SAVE_PHRASE) || text.includes("Для разработчиков"),
      id,
    );
  }
  // Web chats: the address is copied, nothing is executed.
  for (const id of ["chatgpt", "claude-ai"] as const) {
    const copies = clientSetup(origin, id).steps.flatMap((s) => s.copies ?? []);
    assert.ok(copies.some((copy) => copy.kind === "url"));
    assert.ok(!copies.some((copy) => copy.kind === "command"), id);
  }
  // Terminal agents: the phrase first, the command as the fallback.
  for (const id of ["codex", "claude-code"] as const) {
    const [first] = clientSetup(origin, id).steps;
    assert.equal(first.copies?.[0].kind, "phrase");
    assert.equal(first.copies?.[0].value, connectPhrase(origin));
    assert.equal(first.copies?.[1].kind, "command");
    assert.match(first.copies?.[1].lead ?? "", /или выполните сами/);
  }
  // Codex is not the ChatGPT website; the card and the panel both say so.
  assert.match(
    agentClients.find((c) => c.id === "codex")!.hint,
    /не сайт ChatGPT/,
  );
  assert.match(clientSetup(origin, "codex").intro, /ChatGPT/);
});

test("the setup panel renders numbered steps with copy buttons for one client", () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupPanel, {
      setup: clientSetup(origin, "chatgpt"),
      waiting: true,
    }),
  );
  assert.match(html, /data-client="chatgpt"/);
  assert.match(html, /ChatGPT: добавьте коннектор Полки/);
  assert.match(html, /Developer mode/);
  assert.match(html, /https:\/\/polochka\.app\/mcp/);
  assert.match(html, /Скопировать адрес/);
  assert.match(html, /Скопировать фразу/);
  assert.match(html, /Как только агент подключится/);
  assert.equal(html.match(/agent-setup-number/g)?.length, 4);
  const claudeCode = renderToStaticMarkup(
    React.createElement(SetupPanel, {
      setup: clientSetup(origin, "claude-code"),
      waiting: false,
    }),
  );
  assert.match(claudeCode, /Подключи Полку: https:\/\/polochka\.app\/connect/);
  assert.match(
    claudeCode,
    /claude mcp add --transport http --scope user polka/,
  );
  assert.match(claudeCode, /или выполните сами/);
  assert.doesNotMatch(claudeCode, /Как только агент подключится/);
});

test("the choice comes from the address or storage and survives a broken storage", () => {
  assert.equal(parseClientId("chatgpt"), "chatgpt");
  assert.equal(parseClientId("claude-ai"), "claude-ai");
  assert.equal(parseClientId("gemini"), null);
  assert.equal(parseClientId(null), null);
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  storeClient("codex", storage);
  assert.equal(store.get(CLIENT_STORAGE_KEY), "codex");
  assert.equal(readStoredClient(storage), "codex");
  storeClient(null, storage);
  assert.equal(readStoredClient(storage), null);
  store.set(CLIENT_STORAGE_KEY, "nonsense");
  assert.equal(readStoredClient(storage), null);
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readStoredClient(broken), null);
  assert.doesNotThrow(() => storeClient("other", broken));
  assert.equal(readStoredClient(null), null);
});

test("relative time, fresh accounts and the sign-in method read like Russian", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(at(10_000), now), "только что");
  assert.equal(relativeTime(at(60_000), now), "1 минуту назад");
  assert.equal(relativeTime(at(5 * 60_000), now), "5 минут назад");
  assert.equal(relativeTime(at(22 * 60_000), now), "22 минуты назад");
  assert.equal(relativeTime(at(3_600_000), now), "1 час назад");
  assert.equal(relativeTime(at(5 * 3_600_000), now), "5 часов назад");
  assert.equal(relativeTime(at(30 * 3_600_000), now), "вчера");
  assert.equal(relativeTime(at(3 * 86_400_000), now), "3 дня назад");
  assert.match(relativeTime(at(40 * 86_400_000), now), /августа/);
  assert.equal(relativeTime("nonsense", now), "дата неизвестна");

  assert.equal(isFreshAccount(at(3_600_000), now), true);
  assert.equal(isFreshAccount(at(2 * 86_400_000), now), false);
  assert.equal(isFreshAccount(null, now), false);
  assert.equal(isFreshAccount(undefined, now), false);

  const yandex = {
    provider: "yandex",
    name: "Яндекс ID",
    email: "a@yandex.ru",
    linkedAt: at(3_600_000),
    lastUsedAt: at(3_600_000),
  };
  assert.equal(
    signInMethodLabel(signInMethod([yandex], "a@yandex.ru", now)),
    "через Яндекс ID",
  );
  // Linked long ago and not used since: this session came from the mailbox code.
  const stale = {
    ...yandex,
    linkedAt: at(30 * 86_400_000),
    lastUsedAt: at(30 * 86_400_000),
  };
  assert.equal(
    signInMethodLabel(signInMethod([stale], "a@yandex.ru", now)),
    "через почту",
  );
  assert.equal(
    signInMethodLabel(signInMethod([], "a@example.com", now)),
    "через почту",
  );
  assert.equal(signInMethodLabel(signInMethod([], null, now)), "по логину");
  // The most recently used provider wins.
  const vk = {
    ...yandex,
    provider: "vk",
    name: "VK ID",
    lastUsedAt: at(60_000),
  };
  assert.equal(
    signInMethodLabel(signInMethod([yandex, vk], null, now)),
    "через VK ID",
  );
});

test("each connection gets one human status line", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const base: AgentConnection = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Claude",
    scopes: ["context", "capture"],
    audience: `${origin}/mcp`,
    status: "issued",
    kind: "oauth",
    createdAt: new Date(now - 3_600_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    lastSeenAt: null,
  };
  assert.equal(
    connectionStatus(base, now),
    "Доступ разрешён · запросов ещё не было",
  );
  assert.equal(
    connectionStatus({ ...base, kind: "token" }, now),
    "Токен выдан · запросов ещё не было",
  );
  assert.equal(
    connectionStatus(
      {
        ...base,
        status: "seen",
        lastSeenAt: new Date(now - 120_000).toISOString(),
      },
      now,
    ),
    "Работает · последний раз 2 минуты назад",
  );
  assert.equal(
    connectionStatus({ ...base, status: "revoked" }, now),
    "Доступ отозван",
  );
  assert.match(
    connectionStatus({ ...base, status: "expired" }, now),
    /подключите заново/,
  );
  assert.equal(
    connectionStatus({ ...base, status: "expired", kind: "token" }, now),
    "Срок токена истёк",
  );
});

test("/connect, llms.txt and the skill send web ChatGPT and Claude.ai users to the step pages", () => {
  for (const text of [
    connectGuide(origin),
    llmsText(origin),
    skillMarkdown(origin),
  ]) {
    assert.ok(
      text.includes(`${origin}/settings/agents?client=chatgpt`),
      "chatgpt deep link",
    );
    assert.ok(
      text.includes(`${origin}/settings/agents?client=claude-ai`),
      "claude-ai deep link",
    );
    assert.ok(text.includes("Add custom connector"));
    assert.ok(text.includes("Developer mode"));
    assert.ok(text.includes(`${origin}/mcp`));
  }
  // The agent in a web chat relays the steps rather than fetching anything.
  assert.match(llmsText(origin), /do not try to run commands or fetch/);
  assert.match(connectGuide(origin), /Перескажи ему шаги/);
  assert.match(skillMarkdown(origin), /Для разработчиков/);
});
