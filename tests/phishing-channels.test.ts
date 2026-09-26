// Phishing needs an off-page channel (docs/specs/CONTENT_FILTER.md, «Фишинг»;
// docs/specs/ABUSE_PROTECTION.md, section 6): a login form, brand names and
// «подтвердите» are what B2B prototypes and shops show, and nothing typed on
// Полка leaves the page. Realistic pages that must and must not be held; the
// policy for a trusted author; an operator's approval carried over to later
// versions; `moderation.ts recheck --fraud`.
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { inspectHtml } from "../apps/server/html.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { isSuspicious, SignalCollector, scanScript } from "../apps/server/phishing-signals.ts";
import { decideContent, type ModelView } from "../apps/server/content-filter/policy.ts";
import type { FilterResult } from "../apps/server/content-filter/scanner.ts";
import { approveShareAsOperator } from "../apps/server/moderation.ts";
import { recheckFraudHolds, formatFraudRecheck } from "../apps/server/shares.ts";
import { approvedSignalsCover } from "../apps/server/share-moderation.ts";
import { reviewsSettled } from "../apps/server/content-moderation.ts";
import { setContentModels, type ModelClient } from "../apps/server/content-filter/model.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const defaults = { ...config };

afterEach(() => {
  for (const key of ["SHARE_MODERATION", "CONTENT_FILTER_MODE", "CONTENT_FILTER_AUTOBLOCK"] as const)
    (config as any)[key] = (defaults as any)[key];
  setContentModels(undefined);
});

after(async () => {
  await reviewsSettled();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await app.close();
  await db.end();
  s3.destroy();
});

const page = (body: string, title = "Страница") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// Pages that must not be held.

/** The owner's prototype of 25.09.2026, in short: a Yandex 360 sign-in screen. */
const YANDEX_360_PROTOTYPE = page(
  `<header><b>Яндекс 360</b> <span>для бизнеса</span></header>
<main><h1>Войдите в Яндекс 360</h1>
<p>Алиса AI — один агент для всех ролей: администратор, сотрудник, руководитель. Шаг 3 из 31.</p>
<label>Логин <input name="login" placeholder="ivanov@company.ru"></label>
<label>Пароль <input name="password" autocomplete="current-password" placeholder="Пароль"></label>
<button>Подтвердите вход</button>
<p>Мы отправили код из SMS на +7 900 ***-**-12. Введите код из SMS. Не пришёл? Отправьте код подтверждения повторно.</p>
<p>Работает с Apple Calendar, Telegram и Яндекс Мессенджером.</p>
<a href="https://passport.yandex.ru/auth">Войти через Яндекс ID</a>
<a href="https://360.yandex.ru/business/">Тарифы</a>
<p>Вопросы по пилоту? Напишите нам в Telegram @company_pilot.</p>
<p>Никогда не сообщайте код из SMS и пароль, даже сотрудникам поддержки.</p></main>`,
  "Прототип: Алиса AI в Яндекс 360 — один агент для всех ролей (31 шаг)",
);

const SHOP = page(
  `<h1>ТехноМаркет</h1>
<p>Apple iPhone 16 Pro — 119 990 ₽. Samsung Galaxy S25 — 89 990 ₽. Срочная доставка по Москве!</p>
<p>Оплата картой, СБП или при получении. Подтвердите заказ в корзине.</p>
<p>Вопросы? Пишите нам в Telegram @techno_market или звоните +7 495 123-45-67.</p>
<a href="https://t.me/techno_market">Telegram</a> <a href="https://www.apple.com/iphone/">О модели на apple.com</a>`,
  "ТехноМаркет — смартфоны",
);

const SAAS_SIGNUP = page(
  `<h1>TaskFlow — регистрация</h1>
<label>Рабочая почта <input name="email" autocomplete="email"></label>
<label>Пароль <input name="password" autocomplete="new-password"></label>
<h2>Оплата тарифа «Команда»</h2>
<label>Номер карты <input name="card_number" autocomplete="cc-number" placeholder="0000 0000 0000 0000"></label>
<label>CVC <input name="cvc" autocomplete="cc-csc"></label>
<p>Оплатите 990 ₽ в месяц. Подтвердите подписку — отменить можно в любой момент.</p>
<a href="https://app.taskflow.example/login">Уже есть аккаунт? Войти</a>`,
  "TaskFlow",
);

// ---------------------------------------------------------------------------
// Pages that must be held.

const TELEGRAM_CODE = page(
  "<h1>Яндекс ID</h1><p>Ваш аккаунт Яндекс заблокирован, отправьте код из SMS в Telegram @yandex_support</p>",
  "Яндекс ID",
);
const LOOKALIKE_LINK = page(
  `<h1>Яндекс 360</h1><p>Сессия истекла. Войдите снова, чтобы открыть документы.</p><a href="https://yandex-360-login.ru/auth?next=/docs">Войти</a>`,
  "Яндекс 360",
);
const TRANSFER = page(
  "<h1>Вы выиграли!</h1><p>Для получения приза переведите 5000 ₽ на карту 2202 2006 1234 5678 до конца дня.</p>",
  "Розыгрыш",
);
const CALL_AND_DICTATE = page(
  `<h1>Служба безопасности банка</h1><label>Пароль <input name="password" autocomplete="current-password"></label>
<p>Позвоните +7 495 123-45-67, продиктуйте код.</p>`,
  "Безопасность",
);

const standingFresh = { trusted: false, operatorCreated: false };
const standingTrusted = { trusted: true, operatorCreated: false };
const decide = (
  html: string,
  standing = standingFresh,
  model: ModelView | undefined = undefined,
  mode: "strict" | "balanced" = "strict",
) =>
  decideContent({
    filter: inspectHtml(html).filter,
    model,
    standing,
    mode,
    autoblock: false,
    fraud: true,
  });

test("pages without an off-page channel are not fraud; recipients still get the note about secrets", () => {
  for (const [name, html, sensitive] of [
    ["Yandex 360 prototype", YANDEX_360_PROTOTYPE, true],
    ["shop", SHOP, false],
    ["SaaS sign-up with a card form", SAAS_SIGNUP, true],
  ] as const) {
    const read = inspectHtml(html);
    assert.equal(read.filter.hits.fraud, undefined, `${name}: ${read.signals.join()}`);
    assert.equal(isSuspicious(read.signals), false, name);
    // Brands are still recorded (for the operator), and weigh nothing.
    assert.equal(decide(html).action, "none", name);
    assert.equal(read.filter.sensitiveInput, sensitive, name);
  }
  // The production terms of 25.09 score nothing now.
  assert.equal(
    isSuspicious(["brand:apple", "brand:telegram", "brand:yandex", "secret:password", "urgency:confirm"]),
    false,
  );
});

test("pages that send the reader off the page are held for an author who is not trusted", () => {
  for (const [name, html, channel] of [
    ["code to Telegram", TELEGRAM_CODE, "channel:handover"],
    ["look-alike sign-in", LOOKALIKE_LINK, "channel:lookalike-login"],
    ["transfer to a card", TRANSFER, "channel:transfer"],
    ["call and dictate", CALL_AND_DICTATE, "channel:handover"],
  ] as const) {
    const read = inspectHtml(html);
    assert.ok(read.signals.includes(channel), `${name}: ${read.signals.join()}`);
    assert.ok(read.filter.hits.fraud, name);
    assert.equal(read.filter.hits.fraud!.terms[0]!.startsWith("channel:"), true, name);
    assert.equal(decide(html).action, "hold", name);
    assert.equal(decide(html, standingFresh, undefined, "balanced").action, "hold", name);
  }
  const lookalike = inspectHtml(LOOKALIKE_LINK).signals;
  assert.ok(lookalike.includes("lookalike:yandex"), lookalike.join());
  // Brands count next to a channel: the Telegram page scores high.
  assert.ok(inspectHtml(TELEGRAM_CODE).filter.hits.fraud!.score >= 10);
});

test("channel details: look-alike domains, crypto, warnings and sign-in buttons", () => {
  const signals = (html: string) => inspectHtml(page(html)).signals;
  // Look-alikes by letters: IDN with Cyrillic letters, digits for letters.
  const cyrillic = "уаndex.com"; // «у» and «а» are Cyrillic
  for (const host of [cyrillic, domainToASCII(cyrillic)])
    assert.ok(
      signals(`<a href="https://${host}/login">Вход</a>`).includes("channel:lookalike-login"),
      host,
    );
  assert.ok(signals('<a href="https://app1e-id.com/verify">Verify</a>').includes("channel:lookalike-login"));
  assert.ok(signals("<p>Откройте apple-id-verify.com и войдите.</p>").includes("channel:lookalike-login"));
  // Official domains and relative files are not look-alikes.
  for (const html of [
    '<a href="https://id.yandex.ru/security">ID</a>',
    '<a href="https://appleid.apple.com/sign-in">Apple ID</a>',
    '<a href="apple.html">Яблоки</a>',
    '<script src="https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js"></script><script src="https://api-maps.yandex.ru/2.1/?lang=ru_RU"></script>',
    '<a href="https://storage.yandexcloud.net/bucket/login.png">Картинка</a>',
    "<p>Yandex.Market и Yandex.Cloud — сервисы.</p>",
  ])
    assert.equal(signals(html).some((signal) => signal.startsWith("lookalike:")), false, html);
  // A wallet with a request to send to it.
  assert.ok(
    signals("<p>Send 0.05 BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh to unlock your account</p>").includes("channel:crypto"),
  );
  // Warnings and sign-in buttons are no request.
  for (const html of [
    "<p>Никому не сообщайте код из SMS. Никогда не сообщайте пароль.</p>",
    "<p>Never share your password with anyone.</p>",
    "<button>Отправьте код подтверждения повторно</button>",
    "<button>Send verification code</button>",
    "<p>Напишите код на Python, который считает сумму.</p>",
  ])
    assert.equal(
      signals(html).some((signal) => signal === "channel:handover"),
      false,
      html,
    );
  // A script's strings: JSX text and literals.
  const jsx = new SignalCollector();
  scanScript(
    `export default () => <p>Пришлите пароль нам в чат</p>; const url = "https://sberbank-online-verify.ru/login";`,
    jsx,
  );
  assert.ok(jsx.list().includes("channel:handover"), jsx.list().join());
  assert.ok(jsx.list().includes("channel:lookalike-login"), jsx.list().join());
});

test("policy: rules-only fraud of a trusted author is reported once a model reads the work; a model's confirmation holds", () => {
  const filter: FilterResult = inspectHtml(TELEGRAM_CODE).filter;
  const run = (standing: typeof standingTrusted, model: ModelView, mode: "strict" | "balanced" = "strict") =>
    decideContent({ filter, model, standing, mode, autoblock: false, fraud: true }).action;
  const checked: ModelView = { state: "checked", findings: [] };
  const pending: ModelView = { state: "pending", findings: [] };
  const confirmed: ModelView = {
    state: "checked",
    findings: [{ category: "fraud", agreed: true, source: "text", reason: "фишинг" }],
  };
  assert.equal(run(standingTrusted, checked), "notify");
  assert.equal(run(standingTrusted, pending), "notify");
  assert.equal(run(standingTrusted, checked, "balanced"), "notify");
  // With autoblock too: rules-only fraud of a trusted author is not blocked.
  assert.equal(
    decideContent({ filter, model: checked, standing: standingTrusted, mode: "strict", autoblock: true, fraud: true }).action,
    "notify",
  );
  // No model at all: strict still holds.
  assert.equal(run(standingTrusted, { state: "none", findings: [] }), "hold");
  // The model confirms: held.
  assert.equal(run(standingTrusted, confirmed), "hold");
  // Not trusted: held, whatever the model said.
  assert.equal(run(standingFresh, checked), "hold");
  // Only fraud is eased: other categories of a trusted author still wait in strict.
  assert.equal(
    decideContent({
      filter: { v: 1, hits: { gambling: { score: 8, terms: ["казино"] } } },
      model: checked,
      standing: standingTrusted,
      mode: "strict",
      autoblock: false,
      fraud: true,
    }).action,
    "hold",
  );
});

test("approval carry-over: the same or fewer signals pass, new ones hold", () => {
  const approved = new Set(["channel:handover", "channel:phone", "secret:password", "brand:sber"]);
  assert.equal(approvedSignalsCover(approved, ["channel:handover", "secret:password"]), true);
  assert.equal(approvedSignalsCover(approved, ["channel:handover", "channel:phone", "secret:password", "brand:sber", "link:address"]), true);
  assert.equal(approvedSignalsCover(approved, ["channel:handover", "channel:transfer"]), false);
  assert.equal(approvedSignalsCover(approved, ["channel:handover", "brand:yandex"]), false);
  assert.equal(approvedSignalsCover(approved, ["channel:handover", "scan:incomplete"]), false);
  assert.equal(approvedSignalsCover(new Set(), ["channel:handover"]), false);
});

// ---------------------------------------------------------------------------
// With the database.

const address = () =>
  `2001:db8:f::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Owner = { id: string; tenant: string; cookie: string };

async function signedUp(trusted = false): Promise<Owner> {
  const id = randomUUID(),
    tenant = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,trusted_at)
     VALUES($1,$2,'unused',$3,CASE WHEN $4::boolean THEN now() END)`,
    [id, `email-${id}`, `ph-${id.slice(0, 8)}@example.test`, trusted],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [tenant, id]);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), id],
  );
  return { id, tenant, cookie: `polka_session=${token}` };
}

function call(method: "GET" | "POST", url: string, body: unknown, cookie: string) {
  return app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: { origin, cookie },
    payload: body as any,
  });
}

/** Save a page, as a new work or as the next version of `artifactId`. */
async function save(owner: Owner, html: string, artifactId?: string, baseRevisionId?: string) {
  const bytes = Buffer.from(html);
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title: "Страница",
      filename: "page.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
      ...(artifactId ? { artifactId, baseRevisionId } : {}),
    },
    owner.cookie,
  );
  assert.equal(begin.statusCode, 200, begin.body);
  const { uploadId } = begin.json();
  const put = await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    remoteAddress: address(),
    headers: { origin, cookie: owner.cookie, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(put.statusCode, 200, put.body);
  const done = await call("POST", `/api/uploads/${uploadId}/finalize`, {}, owner.cookie);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

async function link(owner: Owner, receipt: { artifactId: string; revisionId: string }) {
  const response = await call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: 7 },
    owner.cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().share.id as string;
}

async function publish(owner: Owner, shareId: string, from: string, to: string) {
  const response = await call(
    "POST",
    `/api/shares/${shareId}/publish`,
    { revisionId: to, expectedPublishedRevisionId: from },
    owner.cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
}

const shareRow = async (shareId: string) =>
  (await db.query("SELECT moderation,moderation_reason,revision_id FROM shares WHERE id=$1", [shareId])).rows[0];

// The page an author keeps revising: a bank-security training mock-up that
// does ask to dictate a code (an off-page channel) and was approved.
const TRAINING = (note: string) =>
  page(
    `<h1>Учебный стенд: звонок «службы безопасности»</h1><label>Пароль <input name="password"></label>
<p>Сценарий мошенника: «Позвоните +7 495 123-45-67, продиктуйте код». ${note}</p>`,
  );

test("an operator's approval carries over to later versions with the same or fewer signals", async () => {
  config.CONTENT_FILTER_MODE = "strict";
  config.SHARE_MODERATION = "auto";
  const owner = await signedUp();
  const first = await save(owner, TRAINING("Версия 1."));
  const shareId = await link(owner, first);
  assert.deepEqual(
    { moderation: (await shareRow(shareId)).moderation, reason: (await shareRow(shareId)).moderation_reason },
    { moderation: "held", reason: "content:fraud" },
  );
  const approval = await approveShareAsOperator(shareId);
  assert.equal(approval.changed, true);
  const event = (
    await db.query(
      "SELECT details FROM moderation_events WHERE share_id=$1 AND action='share.approved'",
      [shareId],
    )
  ).rows[0];
  assert.ok(event.details.approvedSignals.includes("channel:handover"), JSON.stringify(event.details));
  // A new version with the same signals: the link moves to it and stays open.
  const second = await save(owner, TRAINING("Версия 2: исправлены опечатки."), first.artifactId, first.revisionId);
  await publish(owner, shareId, first.revisionId, second.revisionId);
  assert.equal((await shareRow(shareId)).moderation, "none");
  // Fewer signals: open too.
  const third = await save(
    owner,
    page("<h1>Учебный стенд</h1><p>Сценарий: «Позвоните +7 495 123-45-67, продиктуйте код».</p>"),
    first.artifactId,
    second.revisionId,
  );
  await publish(owner, shareId, second.revisionId, third.revisionId);
  assert.equal((await shareRow(shareId)).moderation, "none");
  // A new signal (a transfer to a card): held again.
  const fourth = await save(
    owner,
    TRAINING("И ещё: переведите 5000 ₽ на карту 2202 2006 1234 5678."),
    first.artifactId,
    third.revisionId,
  );
  await publish(owner, shareId, third.revisionId, fourth.revisionId);
  assert.deepEqual(
    { moderation: (await shareRow(shareId)).moderation, reason: (await shareRow(shareId)).moderation_reason },
    { moderation: "held", reason: "content:fraud" },
  );
});

test("strict mode: a trusted author's rules-only phishing opens once the model found nothing; the operator is told", async () => {
  config.CONTENT_FILTER_MODE = "strict";
  config.SHARE_MODERATION = "auto";
  const clean: ModelClient = {
    name: "clean",
    async classify() {
      return { category: "none" as any, reason: "ничего", model: "clean", costRub: 0 };
    },
  };
  setContentModels({ primary: clean, fallback: clean });
  const owner = await signedUp(true);
  const receipt = await save(owner, TRAINING("Для доверенного автора."));
  await reviewsSettled();
  const shareId = await link(owner, receipt);
  assert.equal((await shareRow(shareId)).moderation, "none");
  const flagged = await db.query(
    "SELECT 1 FROM moderation_events WHERE share_id=$1 AND action='share.flagged' AND category='fraud'",
    [shareId],
  );
  assert.equal(flagged.rowCount, 1);
  // Not trusted: the same page waits.
  const fresh = await signedUp();
  const held = await link(fresh, await save(fresh, TRAINING("Для нового автора.")));
  await reviewsSettled();
  assert.equal((await shareRow(held)).moderation, "held");
});

test("recheck --fraud: held links are decided again under the current rules, idempotently, with a journal", async () => {
  config.CONTENT_FILTER_MODE = "strict";
  config.SHARE_MODERATION = "auto";
  const owner = await signedUp();
  // Held under the old rules: the prototype's signals scored 10 then.
  const prototype = await save(owner, YANDEX_360_PROTOTYPE);
  const prototypeShare = await link(owner, prototype);
  const oldSignals = ["brand:apple", "brand:telegram", "brand:yandex", "secret:password", "urgency:confirm"];
  await db.query(
    `UPDATE revisions SET phishing_signals=$2::text[],
       content_filter=jsonb_set(content_filter,'{hits,fraud}',$3::jsonb)
     WHERE id=$1`,
    [prototype.revisionId, oldSignals, JSON.stringify({ score: 10, terms: oldSignals })],
  );
  await db.query(
    "UPDATE shares SET moderation='held',moderation_reason='content:fraud',moderated_at=now() WHERE id=$1",
    [prototypeShare],
  );
  // A real phishing page stays held.
  const phishing = await save(owner, TELEGRAM_CODE);
  const phishingShare = await link(owner, phishing);
  assert.equal((await shareRow(phishingShare)).moderation, "held");

  const dry = await recheckFraudHolds(true, [owner.tenant]);
  const outcome = (report: typeof dry, shareId: string) =>
    report.results.find((result) => result.shareId === shareId)?.outcome;
  assert.equal(outcome(dry, prototypeShare), "released");
  assert.equal(outcome(dry, phishingShare), "kept");
  assert.match(formatFraudRecheck(dry), /Dry run, nothing changed. Would release 1/);
  // A dry run changes nothing.
  assert.equal((await shareRow(prototypeShare)).moderation, "held");
  assert.deepEqual(
    (await db.query("SELECT phishing_signals FROM revisions WHERE id=$1", [prototype.revisionId])).rows[0].phishing_signals,
    oldSignals,
  );

  const real = await recheckFraudHolds(false, [owner.tenant]);
  assert.equal(outcome(real, prototypeShare), "released");
  assert.equal(outcome(real, phishingShare), "kept");
  assert.equal((await shareRow(prototypeShare)).moderation, "none");
  assert.equal((await shareRow(phishingShare)).moderation, "held");
  const revision = (
    await db.query("SELECT phishing_signals,content_filter FROM revisions WHERE id=$1", [prototype.revisionId])
  ).rows[0];
  assert.equal(revision.content_filter.hits.fraud, undefined);
  assert.ok(!revision.phishing_signals.includes("channel:handover"));
  const events = (
    await db.query(
      `SELECT action FROM moderation_events
       WHERE (share_id=$1 OR revision_id=$2) AND action IN ('share.released','revision.rescanned')
       ORDER BY created_at`,
      [prototypeShare, prototype.revisionId],
    )
  ).rows.map((row) => row.action);
  assert.deepEqual(events, ["revision.rescanned", "share.released"]);
  // Again: nothing more to release, no new journal entries.
  const again = await recheckFraudHolds(false, [owner.tenant]);
  assert.deepEqual(again.results.map((result) => result.outcome), ["kept"]);
  const count = (
    await db.query(
      "SELECT count(*)::int AS n FROM moderation_events WHERE revision_id=$1 AND action='revision.rescanned'",
      [prototype.revisionId],
    )
  ).rows[0].n;
  assert.equal(count, 1);
});
