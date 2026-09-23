// Anti-spam at sign-up (docs/specs/CONTENT_FILTER.md, «Спам»): throwaway mail
// services are refused, and new shelves per day are limited per network
// (/24 for IPv4, /48 for IPv6) and per mail domain, on top of the per-IP and
// installation-wide limits of email-auth.ts. The large public providers have
// no per-domain limit: most honest people are there.
import { config } from "./config.ts";
import { recordEvent } from "./content-moderation.ts";
import { filterLists } from "./content-filter/lists.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";

const PUBLIC_PROVIDERS = new Set([
  "yandex.ru",
  "ya.ru",
  "yandex.com",
  "yandex.by",
  "yandex.kz",
  "narod.ru",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "internet.ru",
  "rambler.ru",
  "lenta.ru",
  "vk.com",
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

export const mailDomain = (email: string) =>
  email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** A throwaway mail service, the domain or any parent of it. */
export function disposableEmail(email: string) {
  const labels = mailDomain(email).split(".");
  const { disposable } = filterLists();
  for (let i = 0; i < labels.length - 1; i++)
    if (disposable.has(labels.slice(i).join("."))) return true;
  return false;
}

/** The network an address belongs to: /24 of IPv4, /48 of IPv6. */
export function subnetOf(ip: string) {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    // Expand "::" enough to take the first three groups.
    const [head = ""] = ip.toLowerCase().split("::");
    const groups = head.split(":").filter(Boolean);
    while (groups.length < 3) groups.push("0");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return ip;
}

/** The per-network and per-domain limits, as email-auth.ts's signupKeys. */
export function signupSpamKeys(ip: string, email: string) {
  const domain = mailDomain(email);
  return [
    {
      key: `email-signup-subnet:${subnetOf(ip)}`,
      max: () => config.EMAIL_SIGNUP_DAILY_PER_SUBNET || Number.MAX_SAFE_INTEGER,
      message:
        "Из этой сети сегодня уже создано много полок. Попробуйте завтра или войдите в существующую полку.",
    },
    ...(PUBLIC_PROVIDERS.has(domain) || !config.EMAIL_SIGNUP_DAILY_PER_DOMAIN
      ? []
      : [
          {
            key: `email-signup-domain:${domain}`,
            max: () => config.EMAIL_SIGNUP_DAILY_PER_DOMAIN,
            message:
              "С адресов этого почтового домена сегодня уже создано много полок. Попробуйте завтра.",
          },
        ]),
  ];
}

/** Refuse a throwaway address before any code is sent; journaled. */
export async function assertNotDisposable(email: string) {
  if (!disposableEmail(email)) return;
  await recordEvent(db, {
    actor: "signup",
    action: "signup.refused",
    category: "spam",
    reason: "одноразовый почтовый адрес",
    details: { domain: mailDomain(email) },
  }).catch(() => undefined);
  throw new Problem(
    422,
    "invalid",
    "Адреса одноразовой почты не подходят для регистрации. Укажите постоянный адрес: на него придут код и письма о ваших ссылках.",
  );
}
