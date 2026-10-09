// «Предложить в Ленту» on a department shelf's work (docs/specs/DISCOVER_V2.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedProposalBody, proposalStatus } from "../apps/web/src/features/propose-to-feed/index.tsx";
import { workMenu } from "../apps/web/src/widgets/artifact-reader/index.tsx";
import type { Artifact, Revision } from "../packages/contracts/index.ts";
import type { FeedProposal } from "../packages/contracts/feed-proposal.ts";

const first: Revision = {
  id: "r1",
  number: 1,
  filename: "page.html",
  mime: "text/html",
  size: 30,
  totalSize: 30,
  sha256: "a".repeat(64),
  storageKind: "single",
  htmlProfile: "static",
  inlineBuild: null,
  createdAt: "2026-10-01T00:00:00Z",
};
const second: Revision = { ...first, id: "r2", number: 2 };
const work: Artifact = {
  id: "a",
  title: "Воронка",
  folderId: null,
  updatedAt: first.createdAt,
  trashedAt: null,
  lifecycleVersion: 1,
  revision: second,
  share: null,
};
const proposal: FeedProposal = {
  id: "p",
  revisionId: "r1",
  revisionNumber: 1,
  title: "Разбор воронки",
  summary: "Где теряются заявки",
  state: "pending",
  reason: null,
  proposedBy: "Анна",
  createdAt: first.createdAt,
  decidedAt: null,
};
const draft = { revisionId: "r2", title: "Воронка", summary: "", rights: false, noPersonalData: false };
const render = (value: FeedProposal | null) =>
  renderToStaticMarkup(
    React.createElement(FeedProposalBody, {
      proposal: value,
      revisions: [second, first],
      draft,
      setDraft: () => {},
      error: "",
    }),
  );

test("the menu offers «Предложить в Ленту» only to a department shelf's curator", () => {
  const labels = (access: { own: boolean; change: boolean; curate: boolean; feed?: boolean }) =>
    workMenu({ work, shown: second, setPanel: () => {}, onDownload: () => {}, onCopyForAgent: () => {}, access }).map(
      (item) => item.label,
    );
  assert.ok(labels({ own: false, change: true, curate: true, feed: true }).includes("Предложить в Ленту"));
  assert.ok(!labels({ own: false, change: true, curate: false, feed: false }).includes("Предложить в Ленту"));
  // One's own shelf: no proposals (the default access).
  assert.ok(
    !workMenu({ work, shown: second, setPanel: () => {}, onDownload: () => {}, onCopyForAgent: () => {} }).some(
      (item) => item.label === "Предложить в Ленту",
    ),
  );
  // A work in the trash only downloads.
  const trashed = workMenu({
    work: { ...work, trashedAt: first.createdAt },
    shown: second,
    setPanel: () => {},
    onDownload: () => {},
    onCopyForAgent: () => {},
    access: { own: false, change: true, curate: true, feed: true },
  });
  assert.ok(!trashed.some((item) => item.label === "Предложить в Ленту"));
});

test("without a proposal the form asks for a version, a title, a line and both confirmations", () => {
  const html = render(null);
  assert.match(html, /подборка Редакции Полки/);
  assert.match(html, /Версия 2/);
  assert.match(html, /Заголовок в Ленте/);
  assert.match(html, /Что узнает читатель/);
  assert.match(html, /Отдел вправе показывать эту работу всем/);
  assert.match(html, /нет чужих персональных данных/);
});

test("a waiting proposal shows its state and no form; a refusal shows the reason and the form again", () => {
  const waiting = render(proposal);
  assert.match(waiting, /Предложено в Ленту \(версия 1\)\. Ждёт решения Редакции\./);
  assert.doesNotMatch(waiting, /Заголовок в Ленте/);
  const rejected = render({ ...proposal, state: "rejected", reason: "Нужны источники", decidedAt: first.createdAt });
  assert.match(rejected, /Редакция не взяла работу в Ленту \(версия 1\)\. Причина: Нужны источники/);
  assert.match(rejected, /Заголовок в Ленте/);
  assert.equal(proposalStatus({ ...proposal, state: "published" }), "Редакция взяла работу в Ленту (версия 1).");
});
