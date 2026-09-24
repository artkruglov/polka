// The recipient page's way in for a guest (features/recipient-convert,
// entities/recipient-convert, docs/specs/RECIPIENT_CONVERSION.md): what the
// bar and the card say, that the choice is remembered per browser, that the
// link's token never rides in a URL, a query or an event, and that a sign-up
// started here comes back to the same link with the phrase.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Revision } from "../packages/contracts/index.ts";

// Browser storage for the modules under test: sessionStorage for the tab
// (the token and the visit source), localStorage for the browser (the card).
const session = new Map<string, string>();
const local = new Map<string, string>();
const storage = (store: Map<string, string>) => ({
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
(globalThis as any).sessionStorage = storage(session);
(globalThis as any).localStorage = storage(local);
(globalThis as any).window = globalThis;

const { takeShareAfterSignIn } = await import("../apps/web/src/shared/lib/share-return.ts");
const { setVisitSourceRef, visitSource, visitSourceQuery } = await import(
  "../apps/web/src/shared/lib/visit-source.ts"
);
const { recipientCtaBody, trackRecipientCta } = await import(
  "../apps/web/src/shared/api/recipient-cta.ts"
);
const { connectPhrase } = await import(
  "../apps/web/src/entities/onboarding/connect-phrase.ts"
);
const { arrivedFromShare } = await import("../apps/web/src/entities/onboarding/arrival.ts");
const {
  CARD_DISMISSED_KEY,
  CARD_SHOWN_KEY,
  markCardDismissed,
  markCardShown,
  mayAutoOpen,
  readCardState,
} = await import("../apps/web/src/entities/recipient-convert/card-state.ts");
const { kindWords, remixPrompt } = await import(
  "../apps/web/src/entities/recipient-convert/remix-prompt.ts"
);
const { isFreshAccount } = await import(
  "../apps/web/src/entities/recipient-convert/fresh-account.ts"
);
const { rememberConvertReturn, takeConvertReturn } = await import(
  "../apps/web/src/entities/recipient-convert/return.ts"
);
const {
  AUTO_OPEN_MS,
  ConvertBar,
  ConvertCard,
  SIGN_UP_HREF,
  SignedInFromShare,
  leaveForProvider,
  variantRef,
} = await import("../apps/web/src/features/recipient-convert/index.tsx");
const { FirstRunSteps } = await import("../apps/web/src/features/first-run/index.tsx");
const { deriveFirstRun } = await import("../apps/web/src/entities/onboarding/steps.ts");

const token = "A".repeat(20) + "b_-".repeat(7) + "Z".repeat(2);
const origin = "https://polochka.app";
const title = "Отчёт Ивана Петрова для ООО «Ромашка»";
const revision = (over: Partial<Revision> = {}): Revision => ({
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
  ...over,
});

beforeEach(() => {
  session.clear();
  local.clear();
});

test("the bar: the sentence and two actions, keyboard reachable buttons", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConvertBar, { onTry: () => {}, onRemix: () => {} }),
  );
  assert.match(html, /Эту страницу сделали с ИИ и сохранили на Полку/);
  assert.match(html, /<button[^>]*>[^<]*Попробовать бесплатно/);
  assert.match(html, /aria-label="Сделать такую же"/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.match(html, /aria-label="Полка"/);
});

test("the card (try): the phrase with ref=share, one-click sign-in, email; never the token or the title", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConvertCard, {
      variant: "try",
      origin,
      revision: revision(),
      back: { token },
      signIn: React.createElement("a", { href: "/api/auth/idp/yandex/start?next=%2Fs" }, "Войти с Яндекс ID"),
      onClose: () => {},
    }),
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /Сохраняйте свои работы с ИИ так же/);
  assert.match(html, /Скопируйте своему агенту/);
  assert.ok(html.includes(`Подключи Полку: ${origin}/connect?ref=share<`), html);
  assert.match(html, /Войти с Яндекс ID/);
  assert.match(html, /или по почте/);
  assert.ok(html.includes(`href="${SIGN_UP_HREF}"`));
  assert.equal(SIGN_UP_HREF, "/signup?next=%2Fs");
  assert.ok(!html.includes(token));
  assert.ok(!html.includes(title));
  assert.match(html, /aria-label="Закрыть"/);
});

test("the card (remix): the ready prompt names the kind, not the work, and ref=share-remix", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConvertCard, {
      variant: "remix",
      origin,
      revision: revision({ htmlProfile: "limited" }),
      back: { token },
      onClose: () => {},
    }),
  );
  assert.match(html, /Сделайте такую же с вашим агентом/);
  assert.ok(
    html.includes(
      `Сделай похожую интерактивную страницу и сохрани на Полку. Если Полка не подключена — подключи: ${origin}/connect?ref=share-remix`,
    ),
    html,
  );
  assert.match(html, /Скопировать запрос/);
  // Without a configured provider only the email way remains, in full words.
  assert.match(html, /Создать полку по почте/);
  assert.doesNotMatch(html, /Яндекс/);
  assert.ok(!html.includes(token));
  assert.ok(!html.includes(title));
});

test("kind words for the prompt: two words, by type, never the title", () => {
  assert.equal(kindWords(revision()), "похожую статичную страницу");
  assert.equal(kindWords(revision({ htmlProfile: "limited" })), "похожую интерактивную страницу");
  assert.equal(
    kindWords(revision({ inlineBuild: { state: "ready" } as Revision["inlineBuild"] })),
    "похожую интерактивную страницу",
  );
  assert.equal(kindWords(revision({ mime: "image/png" })), "похожее изображение");
  assert.equal(kindWords(revision({ mime: "text/plain" })), "похожий текстовый документ");
  assert.equal(kindWords(revision({ mime: "application/pdf" })), "похожую страницу");
  assert.ok(!remixPrompt(origin, revision()).includes(title));
  assert.equal(variantRef("try"), "share");
  assert.equal(variantRef("remix"), "share-remix");
  assert.equal(connectPhrase(origin), `Подключи Полку: ${origin}/connect`);
  assert.equal(connectPhrase(origin, "share"), `Подключи Полку: ${origin}/connect?ref=share`);
});

test("the card opens by itself once per browser, and a dismissal is remembered", () => {
  assert.deepEqual(readCardState(), { shown: false, dismissed: false });
  assert.equal(mayAutoOpen(readCardState()), true);
  assert.equal(markCardShown(), true);
  assert.deepEqual(readCardState(), { shown: true, dismissed: false });
  assert.equal(mayAutoOpen(readCardState()), false);
  assert.equal(markCardDismissed(), true);
  assert.deepEqual(readCardState(), { shown: true, dismissed: true });
  assert.equal(local.get(CARD_SHOWN_KEY), "1");
  assert.equal(local.get(CARD_DISMISSED_KEY), "1");
  // No storage (a private window): the card is simply shown again, nothing throws.
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.deepEqual(readCardState(broken), { shown: false, dismissed: false });
  assert.equal(markCardShown(broken), false);
  assert.equal(markCardDismissed(broken), false);
  assert.equal(markCardDismissed(null), false);
  assert.equal(AUTO_OPEN_MS, 15_000);
});

test("events carry two enumerated words: no token, no title, no address", () => {
  const sent: Array<[string, string]> = [];
  const transport = async (path: string, body: string) => void sent.push([path, body]);
  trackRecipientCta({ event: "view", surface: "bar" }, transport);
  trackRecipientCta({ event: "click", action: "remix" }, transport);
  assert.deepEqual(sent, [
    ["/api/recipient-cta", '{"event":"view","surface":"bar"}'],
    ["/api/recipient-cta", '{"event":"click","action":"remix"}'],
  ]);
  const smuggled = { event: "click", action: "try", token, title } as any;
  assert.equal(recipientCtaBody(smuggled), '{"event":"click","action":"try"}');
  // A failing transport never reaches the caller.
  trackRecipientCta({ event: "view", surface: "card" }, () => Promise.reject(new Error("down")));
  trackRecipientCta({ event: "view", surface: "card" }, () => {
    throw new Error("no fetch");
  });
});

test("a feed material: ref feed / feed-remix, the way back is the material's plain path", () => {
  assert.equal(variantRef("try", "feed"), "feed");
  assert.equal(variantRef("remix", "feed"), "feed-remix");
  const path = "/discover/handwriting-research";
  const html = renderToStaticMarkup(
    React.createElement(ConvertCard, {
      variant: "try",
      page: "feed",
      origin,
      revision: revision(),
      back: { path },
      onClose: () => {},
    }),
  );
  assert.ok(html.includes(`Подключи Полку: ${origin}/connect?ref=feed<`), html);
  assert.ok(html.includes(`href="/signup?next=${encodeURIComponent(path)}"`), html);
  assert.ok(!html.includes(token));
  assert.equal(
    recipientCtaBody({ event: "click", action: "try", page: "feed" }),
    '{"event":"click","action":"try","page":"feed"}',
  );
  assert.equal(
    recipientCtaBody({ event: "view", surface: "bar", page: "share" }),
    '{"event":"view","surface":"bar"}',
  );
  // Leaving for a provider from a material keeps the path, not a token.
  leaveForProvider({ path }, "try", "feed");
  assert.deepEqual(visitSource(), { ref: "feed" });
  assert.equal(arrivedFromShare(), true);
  assert.equal(takeShareAfterSignIn(), null);
  assert.equal(takeConvertReturn("/discover/other"), false);
  assert.equal(takeConvertReturn(path), false, "a wrong path consumed the marker");
  leaveForProvider({ path }, "remix", "feed");
  assert.equal(takeConvertReturn(path), true);
  assert.equal(takeConvertReturn(path), false, "used once");
  rememberConvertReturn(path);
  assert.equal(takeConvertReturn(path, undefined, Date.now() + 31 * 60 * 1000), false);
  assert.equal(rememberConvertReturn("https://evil.invalid/"), false);
});

test("leaving for a provider keeps the token in this tab only and marks the source", () => {
  leaveForProvider({ token }, "remix");
  assert.deepEqual(visitSource(), { ref: "share-remix" });
  assert.equal(visitSourceQuery(), "&ref=share-remix");
  assert.ok(!visitSourceQuery().includes(token));
  // The token waits in sessionStorage for /s, and is used once.
  assert.equal(takeShareAfterSignIn(), token);
  assert.equal(takeShareAfterSignIn(), null);
  // The provider start URL is built from the return path and the ref only.
  const start = `/api/auth/idp/yandex/start?next=${encodeURIComponent("/s")}${visitSourceQuery()}`;
  assert.equal(start, "/api/auth/idp/yandex/start?next=%2Fs&ref=share-remix");
});

test("the visit source: the share ref replaces an earlier ref and keeps the referrer host", () => {
  session.set("polka_visit_source", JSON.stringify({ ref: "habr", referrer: "t.me" }));
  assert.equal(arrivedFromShare(), false);
  assert.equal(setVisitSourceRef("share"), true);
  assert.deepEqual(visitSource(), { referrer: "t.me", ref: "share" });
  assert.equal(arrivedFromShare(), true);
  assert.equal(setVisitSourceRef("Not A Ref!"), false);
  assert.deepEqual(visitSource(), { referrer: "t.me", ref: "share" });
});

test("back on the link after sign-up: «Полка создана» for a fresh account, the phrase and «Моя полка»", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(isFreshAccount({ id: "a", name: "n", createdAt: "2026-09-24T11:50:00Z" }, now), true);
  assert.equal(isFreshAccount({ id: "a", name: "n", createdAt: "2026-09-24T09:00:00Z" }, now), false);
  assert.equal(isFreshAccount({ id: "a", name: "n", createdAt: null }, now), false);
  assert.equal(isFreshAccount({ id: "a", name: "n" }, now), false);
  const fresh = renderToStaticMarkup(
    React.createElement(SignedInFromShare, { created: true, origin, onClose: () => {} }),
  );
  assert.match(fresh, /role="status"/);
  assert.match(fresh, /Полка создана\./);
  assert.match(fresh, /Подключите агента одной фразой/);
  assert.ok(fresh.includes(`Подключи Полку: ${origin}/connect?ref=share`));
  assert.match(fresh, /href="\/"[^>]*>Моя полка/);
  const old = renderToStaticMarkup(
    React.createElement(SignedInFromShare, { created: false, origin, onClose: () => {} }),
  );
  assert.match(old, /Вы вошли в Полку\./);
  assert.doesNotMatch(old, /Полка создана/);
});

test("first-run steps for an account that came from a share: the phrase leads, «Загрузить файл» second", () => {
  const model = deriveFirstRun({ connections: [], works: [] });
  const props = {
    model,
    origin,
    variant: "card" as const,
    connections: { status: "ready" as const, retry: () => {} },
    works: { status: "ready" as const, retry: () => {} },
    sample: { busy: false, stage: "", error: "", retrying: false, saved: null, save: () => {} },
    announcement: "",
    onUpload: () => {},
  };
  const html = renderToStaticMarkup(
    React.createElement(FirstRunSteps, { ...props, arrival: "share" }),
  );
  assert.match(html, /data-arrival="share"/);
  assert.match(html, /Подключите агента — и он будет сохранять работы сам/);
  const phraseAt = html.indexOf(`Подключи Полку: ${origin}/connect`);
  const uploadAt = html.indexOf("Загрузить файл");
  assert.ok(phraseAt > 0 && uploadAt > phraseAt, `${phraseAt} ${uploadAt}`);
  assert.doesNotMatch(html, /Сохранить без агента/);
  // Without the arrival the heading is the usual one; without onUpload the link to /bring stays.
  const plain = renderToStaticMarkup(
    React.createElement(FirstRunSteps, { ...props, onUpload: undefined }),
  );
  assert.match(plain, /Три шага до первой ссылки/);
  assert.match(plain, /href="\/bring"/);
});
