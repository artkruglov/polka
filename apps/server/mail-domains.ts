import { getDomain } from "tldts";

// Mail domains for the sign-in rules (docs/specs/SIGN_IN_PROVIDERS.md § 3).
//
// RU_MAIL_DOMAINS: public mail services run by Russian companies. A new shelf
// by an emailed code opens on these (EMAIL_SIGNUP_DOMAINS=ru-only), plus the
// installation's own domain. PUBLIC_MAIL_DOMAINS: services where anyone can
// get an address, Russian or not; an organisation's domain rule (ORG_DOMAINS)
// may never name one, or every user of that service would join the library.

export const RU_MAIL_DOMAINS = Object.freeze([
  // Яндекс
  "yandex.ru",
  "ya.ru",
  "yandex.com",
  "yandex.by",
  "yandex.kz",
  "yandex.ua",
  "narod.ru",
  // VK (Mail.ru)
  "mail.ru",
  "bk.ru",
  "list.ru",
  "inbox.ru",
  "internet.ru",
  "vk.com",
  "vk.ru",
  // Рамблер
  "rambler.ru",
  "ro.ru",
  "lenta.ru",
  "autorambler.ru",
  "myrambler.ru",
  "rambler.ua",
]);

export const PUBLIC_MAIL_DOMAINS = Object.freeze([
  ...RU_MAIL_DOMAINS,
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "tutanota.com",
  "tuta.io",
  "mail.com",
  "qq.com",
  "163.com",
]);

/** The part after the last "@", lower-cased; "" when there is none. */
export function emailDomain(email: string) {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/** The installation's host and its parent domain (app.example.ru → example.ru). */
export function installationDomains(appOrigin: string) {
  const host = new URL(appOrigin).hostname.toLowerCase();
  const registrable = getDomain(host);
  if (!registrable) return [];
  return registrable === host ? [host] : [host, registrable];
}

export type SignupDomains = "any" | readonly string[];

/**
 * EMAIL_SIGNUP_DOMAINS: `any`, `ru-only`, or a comma/space list in which
 * `ru-only` may stand for the curated list. Returns the allowed domains.
 */
export function parseSignupDomains(
  value: string,
  appOrigin: string,
): SignupDomains {
  const entries = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!entries.length || entries.includes("any")) {
    if (entries.length > 1)
      throw new Error("EMAIL_SIGNUP_DOMAINS: `any` stands alone");
    return "any";
  }
  const domains = new Set<string>();
  for (const entry of entries) {
    if (entry === "ru-only") {
      RU_MAIL_DOMAINS.forEach((domain) => domains.add(domain));
      installationDomains(appOrigin).forEach((domain) => domains.add(domain));
    } else if (/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/.test(entry))
      domains.add(entry);
    else throw new Error(`EMAIL_SIGNUP_DOMAINS: not a domain: ${entry}`);
  }
  return Object.freeze([...domains].sort());
}

export function domainAllowed(email: string, domains: SignupDomains) {
  return domains === "any" || domains.includes(emailDomain(email));
}
