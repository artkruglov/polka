import React, { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { visitSourceQuery } from "../../shared/lib/visit-source.ts";
import {
  knownShelf,
  rememberSignInMethod,
} from "../../shared/lib/known-shelf.ts";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";
import {
  loadIdentities,
  type AccountIdentities,
} from "../../entities/account/model/identities.ts";

/**
 * Sign-in with Яндекс ID, VK ID, Google or the company's own IdP
 * (docs/specs/SIGN_IN_PROVIDERS.md § 5). The texts are the providers' own
 * («Войти с …», «Войти через Google»). The Яндекс and VK marks are
 * simplified: replace them with the official SVG buttons from each
 * provider's design page before a public launch. Google's is its standard
 * four-colour «G», unmodified, as its branding guidelines require.
 */
function Mark({ id }: { id: SignInProvider["id"] }) {
  if (id === "google")
    return (
      <svg className="idp-mark" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    );
  if (id === "yandex")
    return (
      <svg className="idp-mark" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#FC3F1D" />
        <text
          x="12"
          y="17"
          textAnchor="middle"
          fontSize="15"
          fontWeight="700"
          fill="#fff"
          fontFamily="Arial, sans-serif"
        >
          Я
        </text>
      </svg>
    );
  if (id === "vk")
    return (
      <svg className="idp-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="7" fill="#fff" />
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontSize="10.5"
          fontWeight="800"
          fill="#0077FF"
          fontFamily="Arial, sans-serif"
        >
          VK
        </text>
      </svg>
    );
  return <Building2 className="idp-mark" aria-hidden="true" />;
}

const label = (provider: SignInProvider) =>
  provider.id === "oidc"
    ? provider.name
    : provider.id === "google"
      ? "Войти через Google"
      : `Войти с ${provider.name}`;

/**
 * Under the buttons when a provider signs in only to a shelf it is linked to
 * (GOOGLE_SIGNUP=link-only), so a newcomer does not expect a shelf from it.
 */
function LinkOnlyNote({ providers }: { providers: SignInProvider[] }) {
  const names = providers.filter((p) => !p.signup).map((p) => p.name);
  if (!names.length) return null;
  return (
    <p className="idp-note">
      {names.join(" и ")} — для тех, кто уже привязал его к своей полке в
      «Способах входа». Новая полка через {names.length > 1 ? "них" : "него"}{" "}
      не открывается.
    </p>
  );
}

/**
 * Buttons that leave for the provider; `next` comes back after sign-in. A
 * browser that remembers a shelf (shared/lib/known-shelf) adds known=1: a
 * sign-in that would open a new shelf then asks first (/signup/choose).
 */
export function ProviderButtons({
  providers,
  next,
  onLeave,
}: {
  providers: SignInProvider[];
  next: string;
  /** Just before the browser leaves for the provider (a count, a token to keep). */
  onLeave?: (provider: SignInProvider) => void;
}) {
  if (!providers.length) return null;
  const known = knownShelf() ? "&known=1" : "";
  return (
    <div
      className="idp-buttons"
      role="group"
      aria-label="Войти через другой сервис"
    >
      {providers.map((provider) => (
        <a
          key={provider.id}
          className={`idp-button idp-button--${provider.id}`}
          href={`/api/auth/idp/${provider.id}/start?next=${encodeURIComponent(next)}${known}${visitSourceQuery()}`}
          onClick={() => {
            rememberSignInMethod(provider.id);
            onLeave?.(provider);
          }}
        >
          <Mark id={provider.id} />
          <span>{label(provider)}</span>
        </a>
      ))}
      <LinkOnlyNote providers={providers} />
    </div>
  );
}

/**
 * The same buttons for a signed-in shelf: they LINK the provider to it (a
 * POST with the session, then the browser leaves). On a provisional shelf
 * this claims it (docs/specs/SIGN_IN_PROVIDERS.md § 8).
 */
export function LinkProviderButtons({
  providers,
  onError,
}: {
  providers: SignInProvider[];
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!providers.length) return null;
  return (
    <div className="idp-buttons" role="group" aria-label="Закрепить полку">
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={`idp-button idp-button--${provider.id}`}
          disabled={busy !== null}
          onClick={async () => {
            setBusy(provider.id);
            try {
              const { location: target } = await request<{ location: string }>(
                `/auth/idp/${provider.id}/link`,
                {},
              );
              location.assign(target);
            } catch (e) {
              onError((e as Error).message);
              setBusy(null);
            }
          }}
        >
          <Mark id={provider.id} />
          <span>{label(provider)}</span>
        </button>
      ))}
    </div>
  );
}

/** «Яндекс ID, VK ID или Google»: the providers this installation offers. */
function providerList(data: AccountIdentities) {
  const names = data.available
    .filter((item) => item.provider !== "oidc")
    .map((item) => item.name);
  if (!names.length) return "способ входа";
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} или ${names.at(-1)}`;
}

const ERRORS: Record<string, string> = {
  state:
    "Вход не завершён: запрос устарел или открыт в другом браузере. Начните вход ещё раз.",
  denied: "Вход отменён. Можно попробовать снова или войти другим способом.",
  provider:
    "Сервис входа не ответил. Попробуйте ещё раз через минуту или войдите другим способом.",
  blocked:
    "Эта полка заблокирована или удаляется. Если это ошибка, напишите оператору Полки.",
  signup:
    "Новые полки сейчас не открываются: регистрация закрыта на сегодня или только по приглашению.",
  domain: "Вход разрешён только сотрудникам компании с почтой её домена.",
  linked:
    "Этот аккаунт уже привязан к другой полке. Войдите через него, чтобы открыть ту полку.",
  link_only:
    "Через Google можно войти только в полку, к которой он уже привязан. Войдите через Яндекс ID, VK ID или по почте и привяжите Google в «Способах входа».",
  unavailable: "Этот способ входа сейчас выключен.",
};

/** The sign-in page's explanation of ?idp_error=<code>. */
export function providerErrorMessage(code: string | null) {
  if (!code) return null;
  return ERRORS[code] ?? ERRORS.provider;
}

/**
 * «Способы входа» in settings: link Яндекс ID, VK ID or Google to the shelf
 * (so a person with a foreign mailbox keeps their shelf), or unlink one
 * while another way in remains (the server refuses the last one).
 */
export function SignInMethods() {
  const [data, setData] = useState<AccountIdentities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = new URLSearchParams(location.search);
  const returned = providerErrorMessage(query.get("idp_error"));
  const linked = query.get("linked") === "1";
  const load = () =>
    loadIdentities()
      .then(setData)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return error ? <Notice tone="error">{error}</Notice> : null;
  if (!data.available.length && !data.identities.length) return null;
  const linkedIds = new Set(data.identities.map((item) => item.provider));
  const link = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const { location: target } = await request<{ location: string }>(
        `/auth/idp/${provider}/link`,
        {},
      );
      location.assign(target);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const unlink = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      await request(`/account/identities/${provider}/unlink`, {});
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Не удалось отвязать. Повторите попытку.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      className="idp-methods"
      id="sign-in"
      aria-labelledby="idp-methods-title"
    >
      <h2 id="idp-methods-title">Способы входа</h2>
      <p className="idp-methods-lead">
        {data.email ? `Код на почту ${data.email}. ` : ""}
        Привяжите {providerList(data)}, чтобы входить через{" "}
        {data.available.length > 1 ? "них" : "него"} — например, если ваша
        почта у иностранного сервиса.
      </p>
      {linked && !returned && <Notice>Способ входа привязан.</Notice>}
      {returned && <Notice tone="error">{returned}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <ul className="idp-methods-list">
        {data.identities.map((item) => (
          <li key={`${item.provider}-${item.linkedAt}`}>
            <span>
              <strong>{item.name}</strong>
              {item.email ? ` · ${item.email}` : ""}
            </span>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void unlink(item.provider)}
            >
              Отвязать
            </Button>
          </li>
        ))}
        {data.available
          .filter((item) => !linkedIds.has(item.provider))
          .map((item) => (
            <li key={item.provider}>
              <span>{item.name}</span>
              <Button
                type="button"
                variant="primary"
                disabled={busy !== null}
                onClick={() => void link(item.provider)}
              >
                Привязать
              </Button>
            </li>
          ))}
      </ul>
    </section>
  );
}
