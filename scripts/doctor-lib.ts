// The pure half of `npm run admin -- ops doctor` (scripts/doctor.ts): what
// each answer means, in Russian, for the person setting up an installation.
// No I/O here, so tests/doctor.test.ts covers every verdict.

export type Mark = "ok" | "fail" | "warn" | "info";
export type Check = { mark: Mark; title: string; detail?: string; hint?: string };

const SYMBOL: Record<Mark, string> = { ok: "✓", fail: "✗", warn: "!", info: "·" };

export const ok = (title: string, detail?: string): Check => ({ mark: "ok", title, detail });
export const fail = (title: string, detail: string | undefined, hint: string): Check => ({
  mark: "fail",
  title,
  detail,
  hint,
});
export const warn = (title: string, detail: string | undefined, hint?: string): Check => ({
  mark: "warn",
  title,
  detail,
  hint,
});
export const info = (title: string, detail: string): Check => ({ mark: "info", title, detail });

/** Exit status: 1 when any check failed; warnings and notes do not fail. */
export const exitCode = (checks: Check[]) => (checks.some((check) => check.mark === "fail") ? 1 : 0);

export function render(checks: Check[]) {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${SYMBOL[check.mark]} ${check.title}${check.detail ? ` — ${check.detail}` : ""}`);
    if (check.hint) lines.push(`    → ${check.hint}`);
  }
  const failed = checks.filter((check) => check.mark === "fail").length;
  const warned = checks.filter((check) => check.mark === "warn").length;
  lines.push(
    "",
    failed
      ? `Не готово: ${failed} ${plural(failed, "проблема", "проблемы", "проблем")}${warned ? `, предупреждений: ${warned}` : ""}.`
      : `Всё в порядке${warned ? `, предупреждений: ${warned}` : ""}.`,
  );
  return lines.join("\n");
}

function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Removes every secret value from a message before it is printed: errors
 * from drivers sometimes echo a connection string or a header.
 */
export function scrub(message: string, secrets: Array<string | undefined | null>) {
  let out = message;
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("…");
  // Credentials inside URLs (postgres://user:password@host).
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1…@");
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** The app and the viewer must be different sites (registrable domains). */
export function siteCheck(appHost: string, viewerHost: string, registrable: (host: string) => string | null): Check {
  const title = "Домен просмотра отделён от приложения";
  if (appHost === viewerHost)
    return fail(
      title,
      `оба адреса — ${appHost}`,
      "VIEWER_HOST_NAME — отдельный домен, например polka-view.company.net при polka.company.ru",
    );
  const app = registrable(appHost);
  const viewer = registrable(viewerHost);
  if (!app || !viewer) return warn(title, `не удалось определить registrable domain для ${app ? viewerHost : appHost}`);
  if (app === viewer)
    return fail(
      title,
      `${appHost} и ${viewerHost} на одном домене ${app}`,
      "браузер считает их одним сайтом, и скрипты страниц оказались бы рядом с сессией владельца; возьмите домен просмотра на другом registrable domain (не view.company.ru, а polka-view.company.net)",
    );
  return ok(title, `${app} ≠ ${viewer}`);
}

/** DNS: every address a host resolves to; the two hosts usually share one VM. */
export function dnsCheck(label: string, host: string, addresses: string[] | Error): Check {
  const title = `DNS ${label} (${host})`;
  if (addresses instanceof Error || !addresses.length)
    return fail(
      title,
      addresses instanceof Error ? addresses.message : "нет адресов",
      "создайте A-запись на публичный IP этой VM (без прокси CDN) и подождите, пока она разойдётся",
    );
  return ok(title, addresses.join(", "));
}

export function sameMachineCheck(app: string[], viewer: string[]): Check | null {
  if (!app.length || !viewer.length) return null;
  if (app.some((address) => viewer.includes(address))) return null;
  return warn(
    "Оба домена ведут на одну машину",
    `приложение ${app.join(", ")}, просмотр ${viewer.join(", ")}`,
    "Caddy на этой VM выпускает сертификаты для обоих доменов: A-записи должны указывать на один IP",
  );
}

const DAY = 86_400_000;

/** TLS: a certificate the system trusts, not about to expire. */
export function certificateCheck(
  label: string,
  host: string,
  result: { validTo: Date; authorized: boolean; error?: string } | Error,
  now = new Date(),
): Check {
  const title = `TLS ${label} (${host})`;
  if (result instanceof Error)
    return fail(
      title,
      result.message,
      "проверьте, что 80 и 443 открыты всему интернету и запущен caddy: docker compose --env-file hosted.env logs caddy",
    );
  if (!result.authorized)
    return fail(
      title,
      result.error ?? "сертификат не доверенный",
      "Caddy ещё не получил сертификат Let's Encrypt: проверьте DNS и docker compose --env-file hosted.env logs caddy",
    );
  const days = Math.floor((result.validTo.getTime() - now.getTime()) / DAY);
  if (days < 0) return fail(title, "сертификат истёк", "перезапустите caddy и посмотрите его журнал");
  if (days < 14)
    return warn(title, `сертификат истекает через ${days} дн.`, "Caddy продлевает сам; если не продлил — журнал caddy");
  return ok(title, `сертификат действует ещё ${days} дн.`);
}

export function httpCheck(title: string, url: string, status: number | Error, expectOk: boolean): Check {
  if (status instanceof Error)
    return fail(
      title,
      `${url}: ${status.message}`,
      "docker compose --env-file hosted.env ps — запущены ли app и caddy",
    );
  if (expectOk ? status >= 200 && status < 300 : status < 500) return ok(title, `${url} → ${status}`);
  return fail(
    title,
    `${url} → ${status}`,
    "журнал приложения: docker compose --env-file hosted.env logs --tail=100 app",
  );
}

export function schemaCheck(applied: number | null | Error, expected: number): Check {
  const title = "База данных";
  if (applied instanceof Error)
    return fail(
      title,
      applied.message,
      "запущен ли postgres (docker compose --env-file hosted.env ps postgres) и совпадает ли POLKA_RUNTIME_PASSWORD с ролью в базе",
    );
  if (applied === null)
    return fail(title, "схема не создана", "docker compose --env-file hosted.env up -d — миграции идут при каждом up");
  if (applied < expected)
    return fail(
      title,
      `схема ${applied}, образ ждёт ${expected}`,
      "миграции не дошли: docker compose --env-file hosted.env up -d и журнал migrate",
    );
  if (applied > expected)
    return fail(
      title,
      `схема ${applied} новее образа (${expected})`,
      "образ старее базы: верните POLKA_IMAGE на версию, которая мигрировала базу",
    );
  return ok(title, `доступна, схема ${applied} — актуальная`);
}

export type StorageProbe = {
  versioning: string | undefined | Error;
  /** The readiness canary storage-check creates: readable, or 404, or an error. */
  canary: "present" | "missing" | Error;
  /** A conditional create over the canary: 412 is right; "skipped" without a canary. */
  conditional: "enforced" | "not-enforced" | "skipped" | Error;
};

export function storageChecks(bucket: string, probe: StorageProbe): Check[] {
  const checks: Check[] = [];
  const title = `Хранилище S3 (${bucket})`;
  if (probe.versioning instanceof Error)
    return [
      fail(
        title,
        probe.versioning.message,
        "проверьте S3_ENDPOINT, имя бакета и ключ приложения (S3_ACCESS_KEY): нужен доступ к объектам и к настройке версионирования",
      ),
    ];
  checks.push(
    probe.versioning === "Enabled"
      ? ok(`${title}: версионирование`, "включено")
      : fail(
          `${title}: версионирование`,
          probe.versioning ? `статус ${probe.versioning}` : "выключено",
          "включите версионирование бакета в консоли хранилища; Полка не включает его сама",
        ),
  );
  if (probe.canary instanceof Error)
    checks.push(fail(`${title}: чтение`, probe.canary.message, "у ключа приложения должно быть право читать объекты"));
  else if (probe.canary === "missing")
    checks.push(
      fail(
        `${title}: чтение`,
        "нет служебного объекта polka-system/readiness-v1",
        "его создаёт storage-check при docker compose --env-file hosted.env up -d",
      ),
    );
  else checks.push(ok(`${title}: чтение`, "служебный объект читается"));
  if (probe.conditional instanceof Error)
    checks.push(
      fail(`${title}: условная запись`, probe.conditional.message, "у ключа приложения должно быть право записи"),
    );
  else if (probe.conditional === "not-enforced")
    checks.push(
      fail(
        `${title}: условная запись`,
        "If-None-Match: * не соблюдается",
        "нужно хранилище с условной записью (Yandex Object Storage, MinIO, AWS S3); без неё версии работ могут перезаписать друг друга",
      ),
    );
  else if (probe.conditional === "enforced")
    checks.push(ok(`${title}: условная запись`, "If-None-Match: * соблюдается"));
  return checks;
}

/** The newest dump in BACKUP_BUCKET/postgres/, as the app key lists it. */
export function backupCheck(
  bucket: string | undefined,
  newest: Date | null | Error,
  intervalSeconds: number,
  now = new Date(),
): Check {
  const title = "Бэкапы базы";
  if (!bucket) return fail(title, "BACKUP_BUCKET не задан", "задайте BACKUP_BUCKET в hosted.env");
  if (newest instanceof Error)
    return fail(
      title,
      `не удалось прочитать список ${bucket}/postgres/: ${newest.message}`,
      "ключу приложения нужно право листинга бакета дампов (README, «Бэкапы и секреты»)",
    );
  const limitHours = Math.round((intervalSeconds / 3600 + 2) * 10) / 10;
  if (!newest)
    return fail(
      title,
      `в ${bucket}/postgres/ ещё нет дампов`,
      "первый дамп пишется при старте backup: docker compose --env-file hosted.env logs backup (ждите «backup ok»); «Access Denied» — у BACKUP_S3_ACCESS_KEY нет права записи в BACKUP_BUCKET",
    );
  const hours = Math.round(((now.getTime() - newest.getTime()) / 3_600_000) * 10) / 10;
  if (hours >= limitHours)
    return fail(
      title,
      `последний дамп ${hours} ч назад (порог ${limitHours} ч)`,
      "docker compose --env-file hosted.env logs backup — ключ бэкапа или место в бакете",
    );
  return ok(title, `последний дамп ${hours} ч назад — ключ бэкапа пишет`);
}

export function smtpCheck(mode: string, host: string | undefined, result: "ok" | Error | null, sentTo?: string): Check {
  const title = "Почта (SMTP)";
  if (mode !== "smtp") return info(title, mode === "local" ? "локальный режим, письма не уходят" : "выключена");
  if (result instanceof Error)
    return fail(
      title,
      `${host}: ${result.message}`,
      "проверьте SMTP_HOST, SMTP_PORT (587 или 465), SMTP_USER, SMTP_PASS и что исходящие на этот порт не закрыты у облака",
    );
  return ok(title, `${host}: соединение и вход приняты${sentTo ? `, проверочное письмо отправлено на ${sentTo}` : ""}`);
}

/** OIDC Discovery § 4.3: the fields Полка needs and the issuer at the same URL. */
export function oidcCheck(url: string | undefined, body: unknown, redirect: string): Check {
  const title = "Вход компании (OIDC)";
  if (!url) return info(title, "не настроен");
  if (body instanceof Error)
    return fail(title, `${url}: ${body.message}`, "адрес должен открываться с этой VM и отдавать JSON");
  const doc = (body ?? {}) as Record<string, unknown>;
  const missing = ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"].filter(
    (key) => typeof doc[key] !== "string",
  );
  if (missing.length)
    return fail(
      title,
      `в ответе нет ${missing.join(", ")}`,
      "OIDC_DISCOVERY_URL — <issuer>/.well-known/openid-configuration",
    );
  const expected = `${String(doc.issuer).replace(/\/$/, "")}/.well-known/openid-configuration`;
  if (expected !== url)
    return fail(title, `issuer ${String(doc.issuer)} не совпадает с адресом`, `OIDC_DISCOVERY_URL=${expected}`);
  return ok(title, `${String(doc.issuer)}; адрес возврата в IdP: ${redirect}`);
}

export type SignInFacts = {
  mailMode: string;
  providers: string[];
  extensions: string[];
  passwordAccounts: number | null;
  companyAdmins: number | null;
  teamShelves: string;
  /** organisation: a cloud for many companies, whose admins come with each organisation. */
  teamShelvesScope?: string;
};

/** At least one way in for people, and someone who administers the company. */
export function signInChecks(facts: SignInFacts): Check[] {
  const ways = [
    ...(facts.mailMode === "smtp" ? ["код на почту"] : []),
    ...facts.providers.map((provider) => (provider === "oidc" ? "вход компании (OIDC)" : provider)),
    ...(facts.extensions.length ? [`расширения: ${facts.extensions.join(", ")}`] : []),
  ];
  const checks: Check[] = [];
  if (ways.length) checks.push(ok("Способы входа", ways.join(", ")));
  else if (facts.passwordAccounts)
    checks.push(
      warn(
        "Способы входа",
        `только логины с паролем от оператора (${facts.passwordAccounts})`,
        "подключите SMTP (MAIL_MODE=smtp) или вход компании (OIDC_*), чтобы люди входили сами",
      ),
    );
  else
    checks.push(
      fail(
        "Способы входа",
        "ни почты, ни SSO, ни аккаунтов",
        "подключите SMTP (MAIL_MODE=smtp) или OIDC_*, а первого администратора впустите ссылкой: scripts/admin.ts account bootstrap <почта>",
      ),
    );
  if (facts.companyAdmins === null) return checks;
  if (facts.teamShelvesScope === "organisation") {
    checks.push(
      info(
        "Администраторы компаний",
        facts.companyAdmins > 0
          ? `${facts.companyAdmins}, по организациям`
          : "по организациям: scripts/admin.ts company org, затем company admin",
      ),
    );
    return checks;
  }
  if (facts.companyAdmins > 0) checks.push(ok("Администратор компании", `${facts.companyAdmins}`));
  else
    checks.push(
      fail(
        "Администратор компании",
        "ещё нет",
        "scripts/admin.ts account bootstrap <почта> — аккаунт, роль и одноразовая ссылка для входа",
      ),
    );
  if (facts.companyAdmins > 0 && facts.teamShelves !== "on")
    checks.push(
      warn(
        "Полки отделов",
        "выключены (TEAM_SHELVES=off)",
        "администратор компании видит свою страницу только при TEAM_SHELVES=on",
      ),
    );
  return checks;
}

export type SettingsFacts = {
  teamShelves: string;
  teamShelvesScope: string;
  webhooks: string;
  serviceAccounts: string;
  htmlLiveMode: string;
  emailSignup: string;
  commentsMode: string;
  operatorContact: string | undefined;
};

export function settingsChecks(facts: SettingsFacts): Check[] {
  return [
    info(
      "Настройки",
      [
        `полки отделов ${facts.teamShelves} (${facts.teamShelvesScope})`,
        `вебхуки ${facts.webhooks}`,
        `сервисные аккаунты ${facts.serviceAccounts}`,
        `интерактивный HTML ${facts.htmlLiveMode}`,
        `регистрация по почте ${facts.emailSignup}`,
        `комментарии ${facts.commentsMode}`,
      ].join("; "),
    ),
    facts.operatorContact
      ? ok("Контакт оператора", facts.operatorContact)
      : warn(
          "Контакт оператора",
          "OPERATOR_CONTACT пуст",
          "адрес для обжалования блокировок, его видят владельцы полок: --set OPERATOR_CONTACT=… или hosted.env",
        ),
  ];
}
