import React, { useEffect, useState } from "react";
import { Link2, UserRoundPlus } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { knownShelf, methodLabel } from "../../shared/lib/known-shelf.ts";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { SignupConsent } from "./consent.tsx";

type Pending = { provider: string; providerName: string; next: string };

const GONE =
  "Вход не завершён: прошло больше 10 минут или он открыт в другом браузере. Войдите ещё раз.";

/**
 * /signup/choose (docs/specs/SIGN_IN_PROVIDERS.md § 1): a provider sign-in
 * would open a NEW shelf, but this browser remembers one. Nothing is created
 * until the person answers. What the provider told us stays on the server;
 * the page learns only which provider it was.
 */
export function SignupChoose() {
  const account = useAccount();
  const hint = knownShelf();
  const next = safeNext(new URLSearchParams(location.search).get("next")) || "/start";
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    request<Pending>("/auth/idp/pending")
      .then(setPending)
      .catch((e) =>
        setError(e instanceof ApiError && e.status === 410 ? GONE : (e as Error).message),
      );
  }, []);
  const provider = pending?.providerName ?? "этот вход";
  const how = methodLabel(hint?.method ?? null);
  const signInExisting = () => {
    const linked = `/signup/linked?${new URLSearchParams({ next })}`;
    location.assign(
      `/signup?${new URLSearchParams({ link: "pending", next: linked })}`,
    );
  };
  const createNew = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await request<{ next: string }>(
        "/auth/idp/pending/create",
        {},
      );
      location.assign(safeNext(created.next) || "/start");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 410 ? GONE : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <AppShell current="shelf" account={account}>
      <main className="onboard">
        <div className="onboard-icon">
          <Link2 />
        </div>
        <span className="eyebrow">Одна полка — один человек</span>
        <h1>
          {hint
            ? `Похоже, у вас уже есть полка «${hint.displayName}».`
            : "Похоже, у вас уже есть полка."}
        </h1>
        <p>
          Войдите в неё — и мы привяжем {provider} к ней: дальше {provider}{" "}
          будет открывать ту же полку.
          {how ? ` В прошлый раз вы входили ${how}.` : ""}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        {pending && (
          <div className="shelf-choice">
            <Button variant="primary" onClick={signInExisting} disabled={busy}>
              Войти в существующую полку
            </Button>
            <Button onClick={() => void createNew()} busy={busy}>
              <UserRoundPlus /> Создать новую полку
            </Button>
          </div>
        )}
        {!pending && error && (
          <a className="onboard-legacy" href={`/signup?${new URLSearchParams({ next })}`}>
            Ко входу
          </a>
        )}
        {pending && <SignupConsent />}
      </main>
    </AppShell>
  );
}

/**
 * /signup/linked: the person signed in to their existing shelf; the waiting
 * provider is linked to it now, then the original destination opens.
 */
export function SignupLinked() {
  const account = useAccount();
  const next = safeNext(new URLSearchParams(location.search).get("next")) || "/";
  const [state, setState] = useState<
    { kind: "busy" } | { kind: "done"; provider: string; next: string } | { kind: "error"; message: string }
  >({ kind: "busy" });
  useEffect(() => {
    request<{ providerName: string; next: string }>("/auth/idp/pending/link", {})
      .then((linked) =>
        setState({
          kind: "done",
          provider: linked.providerName,
          next: safeNext(linked.next) || next,
        }),
      )
      .catch((e) =>
        setState({
          kind: "error",
          message: e instanceof ApiError && e.status === 410 ? GONE : (e as Error).message,
        }),
      );
  }, []);
  useEffect(() => {
    if (state.kind !== "done") return;
    const timer = setTimeout(() => location.assign(state.next), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <AppShell current="shelf" account={account}>
      <main className="onboard">
        <div className="onboard-icon">
          <Link2 />
        </div>
        <span className="eyebrow">Способы входа</span>
        <h1>
          {state.kind === "done"
            ? `${state.provider} привязан.`
            : state.kind === "error"
              ? "Привязать не получилось."
              : "Привязываем…"}
        </h1>
        {state.kind === "done" && (
          <p>
            Теперь {state.provider} открывает полку
            {account ? ` «${account.name}»` : ""}. Возвращаем вас дальше…
          </p>
        )}
        {state.kind === "error" && <Notice tone="error">{state.message}</Notice>}
        {state.kind !== "busy" && (
          <div className="shelf-choice">
            <Button
              variant="primary"
              onClick={() => location.assign(state.kind === "done" ? state.next : next)}
            >
              Продолжить
            </Button>
          </div>
        )}
      </main>
    </AppShell>
  );
}
