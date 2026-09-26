import React from "react";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { ProviderButtons } from "../../features/provider-sign-in/index.tsx";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";

// What the code screen says about an address the code may never reach.
// The server answers «код отправлен» for every address (anti-enumeration in
// apps/server/email-auth.ts), so only the interface, which knows the public
// domain rule from /api/capabilities, can warn: it never learns whether a
// shelf exists, it only repeats the rule.

export const SPAM_HINT =
  "Письмо не пришло за минуту? Проверьте «Спам» и «Промоакции».";

/** The part after the last "@", lower-cased and trimmed; "" when there is none. */
export function typedDomainOf(email: string) {
  return email.includes("@")
    ? email
        .slice(email.lastIndexOf("@") + 1)
        .trim()
        .toLowerCase()
    : "";
}

/** A complete-looking domain that the sign-up list does not name. */
export function outsideSignupDomains(
  domain: string,
  signupDomains: "any" | readonly string[],
) {
  return (
    signupDomains !== "any" &&
    /\.[a-z]{2,}$/.test(domain) &&
    !signupDomains.includes(domain)
  );
}

/** «на почте Яндекса, Mail.ru, Рамблера и VK» for ru-only, else the list. */
export function signupDomainsPhrase(signupDomains: "any" | readonly string[]) {
  if (signupDomains === "any") return "на любой почте";
  if (signupDomains.includes("yandex.ru") && signupDomains.includes("mail.ru"))
    return "на почте Яндекса, Mail.ru, Рамблера и VK";
  if (signupDomains.length && signupDomains.length <= 3)
    return `на адресах ${signupDomains.map((d) => `@${d}`).join(", ")}`;
  return "только на разрешённых адресах";
}

export type CodeScreenNotice =
  /** EMAIL_LOGIN_DOMAINS=signup: no code for this domain at all. */
  | { kind: "never"; text: string }
  /** A code comes only if a shelf on this address already exists. */
  | { kind: "if-shelf"; text: string }
  | null;

export function codeScreenNotice(input: {
  email: string;
  delivery: string;
  inviteOnly: boolean;
  signupDomains: "any" | readonly string[];
  loginDomains: "any" | "signup";
}): CodeScreenNotice {
  const domain = typedDomainOf(input.email);
  if (
    input.delivery === "local" ||
    input.inviteOnly ||
    !outsideSignupDomains(domain, input.signupDomains)
  )
    return null;
  if (input.loginDomains === "signup")
    return {
      kind: "never",
      text: `Код на адреса @${domain} на этой Полке не отправляется: вход по почте открыт ${signupDomainsPhrase(input.signupDomains)}.`,
    };
  return {
    kind: "if-shelf",
    text: `Если полки на адресе @${domain} ещё нет, код не придёт: новые полки открываются ${signupDomainsPhrase(input.signupDomains)}.`,
  };
}

/**
 * Above the code field when the address is outside the sign-up list: the
 * rule, the providers that open a shelf right away, and a way back to the
 * address field.
 */
export function OutsideDomainHelp({
  notice,
  providers,
  next,
  busy,
  onChangeAddress,
}: {
  notice: Exclude<CodeScreenNotice, null>;
  providers: SignInProvider[];
  next: string;
  busy: boolean;
  onChangeAddress: () => void;
}) {
  const openers = providers.filter((p) => p.id !== "oidc" && p.signup);
  return (
    <section className="code-help" aria-live="polite">
      <Notice>{notice.text}</Notice>
      {openers.length > 0 && (
        <>
          <p className="code-help-lead">
            Войдите одним нажатием — полка откроется сразу:
          </p>
          <ProviderButtons providers={openers} next={next} />
        </>
      )}
      <Button type="button" disabled={busy} onClick={onChangeAddress}>
        Изменить адрес
      </Button>
      {notice.kind === "if-shelf" && (
        <div className="idp-or">или введите код, если полка уже есть</div>
      )}
    </section>
  );
}
