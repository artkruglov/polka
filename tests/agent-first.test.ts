// Agent-first flows: the harvest task after connecting, the skill line, and
// the one-phrase copies on the work page. The web copy and what /connect,
// /llms.txt and the skill tell the agent are kept equal here.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Artifact, Revision } from "../packages/contracts/index.ts";
import {
  SKILL_INSTALL as serverSkillInstall,
  harvestPrompts as serverHarvest,
  connectGuide,
} from "../apps/server/connect-guide.ts";
import {
  llmsText,
  mcpToolCatalog,
  ownerPhrases,
  skillDescription,
  skillMarkdown,
} from "../apps/server/agent-discovery.ts";
import {
  agentGetArtifactInputSchema,
  artifactIdOf,
  artifactRef,
} from "../apps/server/agent-management.ts";
import {
  agentCommentsInputSchema,
  agentNoteInputSchema,
} from "../apps/server/agent-comments.ts";
import {
  SKILL_INDEX_PATH,
  SKILL_INSTALL,
  harvestClient,
  harvestClients,
  harvestPrompt,
  harvestPrompts,
} from "../apps/web/src/entities/onboarding/agent-setup.ts";
import { HarvestPrompt } from "../apps/web/src/entities/onboarding/HarvestPrompt.tsx";
import { deriveFirstRun } from "../apps/web/src/entities/onboarding/steps.ts";
import {
  improvePhrase,
  notesPhrase,
  shelfUrl,
  updatePhrase,
} from "../apps/web/src/entities/artifact/agent-phrases.ts";
import { FirstRunSteps } from "../apps/web/src/features/first-run/index.tsx";
import { NextStep } from "../apps/web/src/pages/agents/index.tsx";
import { ArtifactReader, workMenu } from "../apps/web/src/widgets/artifact-reader/index.tsx";
import { UploadPanel } from "../apps/web/src/features/upload-artifact/index.tsx";
import { ReworkArtifactPanel } from "../apps/web/src/features/rework-artifact/index.tsx";

const origin = "https://polochka.app";
const id = "6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f";
const url = shelfUrl(origin, id);
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
const work: Artifact = {
  id,
  title: "Отчёт за квартал",
  folderId: null,
  updatedAt: "2026-09-21T10:00:00Z",
  trashedAt: null,
  lifecycleVersion: 1,
  revision,
  share: null,
};

test("the harvest task is one text for terminal agents and one for web chats, the same everywhere", () => {
  assert.deepEqual(harvestPrompts, serverHarvest);
  assert.equal(harvestPrompt("claude-code"), harvestPrompts.terminal);
  assert.equal(harvestPrompt("codex"), harvestPrompts.terminal);
  assert.equal(harvestPrompt("claude-ai"), harvestPrompts.chat);
  assert.equal(harvestPrompt("chatgpt"), harvestPrompts.chat);
  assert.match(
    harvestPrompts.terminal,
    /^Посмотри наши прошлые сессии и файлы проекта на этом компьютере\./,
  );
  assert.match(
    harvestPrompts.chat,
    /^Поищи в наших прошлых чатах \(поиск по истории\/памяти\)\./,
  );
  for (const text of Object.values(harvestPrompts)) {
    assert.match(text, /3–5 самых интересных работ/);
    assert.match(text, /Пропусти личное/);
    assert.match(text, /После моего «да»/);
    assert.match(text, /polka_publish/);
  }
  // «Другое» and no choice read like a terminal agent; web chats keep their tab.
  assert.equal(harvestClient(null), "claude-code");
  assert.equal(harvestClient("other"), "claude-code");
  assert.equal(harvestClient("chatgpt"), "chatgpt");
  assert.deepEqual(
    harvestClients.map((c) => c.id),
    ["claude-code", "codex", "claude-ai", "chatgpt"],
  );
  for (const text of [
    connectGuide(origin),
    llmsText(origin),
    skillMarkdown(origin),
  ]) {
    assert.ok(text.includes(harvestPrompts.terminal), "terminal task");
    assert.ok(text.includes(harvestPrompts.chat), "chat task");
  }
  assert.match(llmsText(origin), /\n## After connecting\n/);
  assert.match(skillMarkdown(origin), /\n## 3\. First session/);
  assert.match(connectGuide(origin), /## Первая сессия/);
});

test("the skill line names the same package on the landing, in /connect, llms.txt and the skill", () => {
  assert.equal(SKILL_INSTALL, serverSkillInstall);
  assert.equal(SKILL_INSTALL, "npx skills add artkruglov/polka");
  for (const text of [connectGuide(origin), llmsText(origin)]) {
    assert.ok(text.includes(SKILL_INSTALL));
    assert.ok(text.includes(`${origin}${SKILL_INDEX_PATH}`));
  }
  assert.match(
    connectGuide(origin),
    /Плагин для Claude Code и Codex \(команды выше\) ставит их сам/,
  );
  assert.match(skillDescription(origin), /Открой на Полке работу/);
});

test("the owner's phrases name the work by title and shelf address; the agent side knows them", () => {
  assert.equal(url, `${origin}/works/${id}`);
  assert.equal(
    improvePhrase("Отчёт", url),
    `Открой на Полке работу «Отчёт» (${url}) и помоги её улучшить.`,
  );
  assert.equal(updatePhrase("Отчёт", url), `Обнови работу «Отчёт» (${url}).`);
  assert.equal(
    notesPhrase("Отчёт", url),
    `Поправь работу «Отчёт» (${url}) по моим заметкам на Полке.`,
  );
  assert.match(
    notesPhrase("Отчёт", url, "comments"),
    /по комментариям на Полке\.$/,
  );
  assert.equal(ownerPhrases.improve("Отчёт", url), improvePhrase("Отчёт", url));
  assert.equal(ownerPhrases.update("Отчёт", url), updatePhrase("Отчёт", url));
  assert.equal(ownerPhrases.notes("Отчёт", url), notesPhrase("Отчёт", url));
  for (const text of [llmsText(origin), skillMarkdown(origin)]) {
    assert.ok(text.includes(`${origin}/works/<id>`));
    assert.ok(
      text.includes(ownerPhrases.improve("<title>", `${origin}/works/<id>`)),
    );
    assert.ok(
      text.includes(ownerPhrases.notes("<title>", `${origin}/works/<id>`)),
    );
    assert.match(text, /author\.owner true/);
    assert.match(text, /polka_get_artifact \{artifactId: that address or id\}/);
  }
  const get = mcpToolCatalog().find(
    (tool) => tool.name === "polka_get_artifact",
  )!;
  assert.match(get.summary, /by its id or by the address of its page/);
});

test("polka_get_artifact, polka_comments and polka_note take the work's page address as well as its id", () => {
  assert.equal(artifactIdOf(id), id);
  assert.equal(artifactIdOf(url), id);
  assert.equal(artifactIdOf(`${url}?revision=r2#top`), id);
  assert.equal(
    artifactIdOf(`http://127.0.0.1:6290/works/${id.toUpperCase()}/`),
    id,
  );
  assert.equal(artifactRef.parse(url), url);
  assert.equal(artifactRef.parse(id), id);
  assert.throws(() => artifactRef.parse("Отчёт"));
  assert.throws(() => artifactRef.parse(`${origin}/s#token`));
  assert.throws(() => artifactRef.parse(`${origin}/works/not-an-id`));
  assert.equal(
    agentGetArtifactInputSchema.parse({ artifactId: url }).artifactId,
    url,
  );
  assert.equal(
    agentCommentsInputSchema.parse({ artifactId: url }).artifactId,
    url,
  );
  assert.equal(
    agentNoteInputSchema.parse({ artifactId: url, body: "Заметка" }).artifactId,
    url,
  );
});

function steps(over: Partial<Parameters<typeof FirstRunSteps>[0]> = {}) {
  return renderToStaticMarkup(
    React.createElement(FirstRunSteps, {
      model: deriveFirstRun({ connections: [], works: [] }),
      origin,
      variant: "card",
      connections: { status: "ready", retry: () => {} },
      works: { status: "ready", retry: () => {} },
      sample: {
        busy: false,
        stage: "",
        error: "",
        retrying: false,
        saved: null,
        save: () => {},
      },
      announcement: "",
      client: "claude-code",
      onClient: () => {},
      onUpload: () => {},
      ...over,
    }),
  );
}

test("step 2 leads with the harvest task for the chosen client, then the file, then the example", () => {
  const html = steps();
  assert.match(html, /Сохраните первые работы/);
  assert.match(html, /Скопировать задание агенту/);
  assert.ok(html.includes(harvestPrompts.terminal));
  assert.ok(!html.includes(harvestPrompts.chat));
  for (const client of harvestClients)
    assert.ok(html.includes(`>${client.name}<`), client.name);
  assert.match(html, /aria-pressed="true"[^>]*>Claude Code</);
  const taskAt = html.indexOf("Скопировать задание агенту");
  const uploadAt = html.indexOf("Загрузить файл");
  const sampleAt = html.indexOf("Сохранить пример");
  assert.ok(
    taskAt > 0 && uploadAt > taskAt && sampleAt > uploadAt,
    `${taskAt} ${uploadAt} ${sampleAt}`,
  );
  assert.match(html, /ui-button--quiet[^>]*>Сохранить пример/);
  assert.doesNotMatch(html, /Попробовать за 10 секунд|Сохранить без агента/);
  // A web chat: its own task, and the tab says so.
  const chat = steps({ client: "chatgpt" });
  assert.ok(chat.includes(harvestPrompts.chat));
  assert.ok(!chat.includes(harvestPrompts.terminal));
  assert.match(chat, /aria-pressed="true"[^>]*>ChatGPT</);
  // The step done: no task to copy.
  const done = steps({
    model: deriveFirstRun({ connections: [], works: [work] }),
  });
  assert.doesNotMatch(done, /Скопировать задание агенту/);
});

test("the agents page, once connected, offers the same task under «Что дальше»", () => {
  const html = renderToStaticMarkup(
    React.createElement(NextStep, { client: "codex", onClient: () => {} }),
  );
  assert.match(html, /Что дальше: соберите свои лучшие работы/);
  assert.ok(html.includes(harvestPrompts.terminal));
  assert.match(html, /aria-pressed="true"[^>]*>Codex</);
  const prompt = renderToStaticMarkup(
    React.createElement(HarvestPrompt, {
      client: "claude-ai",
      onClient: () => {},
      primary: false,
    }),
  );
  assert.ok(prompt.includes(harvestPrompts.chat));
  assert.match(
    prompt,
    /ui-button--secondary[^>]*>[\s\S]*?Скопировать задание агенту/,
  );
});

test("the work page copies one phrase; the new-version panel asks the agent first", () => {
  const reader = renderToStaticMarkup(
    React.createElement(ArtifactReader, {
      work,
      shelfUrl: url,
      shown: revision,
      revisions: [revision],
      viewed: null,
      folderName: "Полка",
      history: false,
      setHistory: () => {},
      setViewed: () => {},
      setPanel: () => {},
      preview: null,
      onDownload: () => {},
    }),
  );
  // «Скопировать для агента» is the first action in «…»; the phrase names the page.
  assert.match(reader, /aria-label="Ещё действия"/);
  const menu = workMenu({ work, shown: revision, setPanel: () => {}, onDownload: () => {}, onCopyForAgent: () => {} });
  assert.equal(menu[0]?.label, "Скопировать для агента");
  assert.match(improvePhrase(work.title, url), new RegExp(url.replace(/[.?]/g, "\\$&")));
  assert.doesNotMatch(reader, /artifactId:|revisionId:/);

  const version = renderToStaticMarkup(
    React.createElement(UploadPanel, {
      artifact: work,
      shelfUrl: url,
      folders: [],
      folderId: null,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  assert.match(version, /Попросите агента/);
  assert.ok(version.includes(updatePhrase(work.title, url)));
  assert.match(version, /Загрузить файл или вставить текст/);
  assert.doesNotMatch(version, /Сохранить на полку/);
  assert.match(version, />Закрыть</);
  const fresh = renderToStaticMarkup(
    React.createElement(UploadPanel, {
      folders: [],
      folderId: null,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  assert.doesNotMatch(fresh, /Попросите агента/);
  assert.match(fresh, /Сохранить на полку/);

  const rework = renderToStaticMarkup(
    React.createElement(ReworkArtifactPanel, {
      title: work.title,
      shelfUrl: url,
      onClose: () => {},
      onUpload: () => {},
    }),
  );
  assert.ok(rework.includes(updatePhrase(work.title, url)));
});
