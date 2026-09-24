import React, { useEffect, useState } from "react";
import { KeyRound, Mail } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Notice } from "../../shared/ui/controls.tsx";
import { OPEN_SHELF_PHRASE } from "../../shared/lib/known-shelf.ts";
import { loadCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";
import { ProviderButtons } from "../../features/provider-sign-in/index.tsx";

type Hint = {
  displayName: string;
  providers: SignInProvider["id"][];
  email: string | null;
  password: boolean;
};

/**
 * /signin?shelf=… (docs/specs/SIGN_IN_PROVIDERS.md § 10): where an agent's
 * «Открой мою Полку» leads for a claimed shelf. The hint carries no secret;
 * the page shows that shelf's own ways in and the person signs in as usual.
 */
export function SignIn() {
  const account = useAccount();
  const hint = new URLSearchParams(location.search).get("shelf") ?? "";
  const [shelf, setShelf] = useState<Hint | null>(null);
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      request<Hint>(`/auth/shelf-hint?${new URLSearchParams({ h: hint })}`),
      loadCapabilities(),
    ])
      .then(([value, capabilities]) => {
        setShelf(value);
        setProviders(
          capabilities.signInProviders.filter((provider) =>
            value.providers.includes(provider.id),
          ),
        );
      })
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status < 500
            ? `Подсказка устарела. Попросите агента новую: «${OPEN_SHELF_PHRASE}».`
            : (e as Error).message,
        ),
      );
  }, []);
  return (
    <AppShell current="shelf" account={account}>
      <main className="onboard">
        <div className="onboard-icon">
          <KeyRound />
        </div>
        <span className="eyebrow">Вход в полку</span>
        {shelf ? (
          <>
            <h1>Войдите в полку «{shelf.displayName}».</h1>
            {account && (
              <Notice>
                Этот браузер уже вошёл в полку «{account.name}». Вход ниже
                откроет выбранную.
              </Notice>
            )}
            <p>Так же, как входили раньше:</p>
            <ProviderButtons providers={providers} next="/" />
            {shelf.email && (
              <a
                className="ui-button ui-button--secondary ui-button--block"
                href="/signup?next=%2F"
              >
                <Mail /> Код на почту {shelf.email}
              </a>
            )}
            {shelf.password && (
              <a className="onboard-legacy" href="/?login=1&next=%2F">
                <KeyRound size={15} /> Логин и пароль этой Полки
              </a>
            )}
          </>
        ) : error ? (
          <>
            <h1>Не получилось.</h1>
            <Notice tone="error">{error}</Notice>
            <a className="onboard-legacy" href="/signup">
              Войти другим способом
            </a>
          </>
        ) : (
          <p role="status">Загружаем…</p>
        )}
      </main>
    </AppShell>
  );
}
