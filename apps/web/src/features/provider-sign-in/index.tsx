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
 * Sign-in with Яндекс ID, VK ID or the company's own IdP
 * (docs/specs/SIGN_IN_PROVIDERS.md § 5). The texts are the providers' own
 * («Войти с …»); the marks are simplified. Replace them with the official
 * SVG buttons from each provider's design page before a public launch.
 */
function Mark({ id }: { id: SignInProvider["id"] }) {
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
  provider.id === "oidc" ? provider.name : `Войти с ${provider.name}`;

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
  unavailable: "Этот способ входа сейчас выключен.",
};

/** The sign-in page's explanation of ?idp_error=<code>. */
export function providerErrorMessage(code: string | null) {
  if (!code) return null;
  return ERRORS[code] ?? ERRORS.provider;
}

/**
 * «Способы входа» in settings: link Яндекс ID or VK ID to the shelf (so a
 * person with a foreign mailbox keeps their shelf), or unlink one while
 * another way in remains.
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
        Привяжите Яндекс ID или VK ID, чтобы входить через них — например, если
        ваша почта у иностранного сервиса.
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
