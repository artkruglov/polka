import React, { useEffect, useState } from "react";
import { Mail, ShieldCheck } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { AskAgentHint } from "../../shared/ui/AskAgentHint.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import {
  loadCapabilities,
  useSignInWays,
} from "../../entities/capabilities/useCapabilities.ts";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";
import {
  LinkProviderButtons,
  ProviderButtons,
  providerErrorMessage,
} from "../../features/provider-sign-in/index.tsx";

type Collision = {
  method: string;
  methodName: string;
  targetName: string;
  works: number;
  connections: Array<{
    id: string;
    name: string;
    kind: "oauth" | "token";
    createdAt: string;
    lastSeenAt: string | null;
  }>;
};

/**
 * /claim (docs/specs/SIGN_IN_PROVIDERS.md § 8): a provisional shelf gets a
 * sign-in method — Яндекс ID, VK ID or an address on an allowed domain — and
 * becomes an ordinary shelf that can share links. The method is attached to
 * THIS shelf. When it already opens another shelf of the same person, the
 * page offers to merge the provisional one into it.
 */
export function Claim() {
  const account = useAccount();
  const ways = useSignInWays();
  const query = new URLSearchParams(location.search);
  const next = safeNext(query.get("next")) || "/?claimed=1";
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [emailLogin, setEmailLogin] = useState(false);
  const [collision, setCollision] = useState<Collision | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(
    providerErrorMessage(query.get("idp_error")) ?? "",
  );
  const [busy, setBusy] = useState<"merge" | "switch" | "cancel" | null>(null);
  // A session from an agent's link: sign in for real, then carry works over.
  const [weak, setWeak] = useState(false);
  // Agents that move with the works: the person ticks their own, none by default.
  const [keep, setKeep] = useState<string[]>([]);
  useEffect(() => {
    if (account === null)
      location.replace(`/signup?${new URLSearchParams({ next: "/" })}`);
    if (!account) return;
    Promise.all([
      loadCapabilities(),
      request<{
        provisional: boolean;
        weak: boolean;
        collision: Collision | null;
      }>("/account/claim"),
    ])
      .then(([capabilities, claim]) => {
        setProviders(capabilities.signInProviders);
        setEmailLogin(capabilities.emailLogin !== "disabled");
        setCollision(claim.collision);
        setWeak(claim.weak);
        if (!claim.provisional && !claim.collision) location.replace("/");
        setLoaded(true);
      })
      .catch((e) => {
        setError((e as Error).message);
        setLoaded(true);
      });
  }, [account]);

  const act = async (kind: "merge" | "switch" | "cancel") => {
    setBusy(kind);
    setError("");
    try {
      await request(
        `/account/claim/${kind}`,
        kind === "merge" ? { connections: keep } : {},
      );
      if (kind === "cancel") {
        setCollision(null);
        setBusy(null);
        return;
      }
      location.assign(kind === "merge" ? "/?claimed=1" : "/");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 410
          ? "Прошло больше 10 минут. Войдите ещё раз, чтобы объединить полки."
          : (e as Error).message,
      );
      setBusy(null);
      if (e instanceof ApiError && e.status === 410) setCollision(null);
    }
  };

  return (
    <AppShell current="shelf" account={account}>
      <main className="onboard">
        <div className="onboard-icon">
          <ShieldCheck />
        </div>
        <span className="eyebrow">Временная полка</span>
        {collision ? (
          <>
            <h1>У вас уже есть полка «{collision.targetName}».</h1>
            <p>
              {collision.methodName} открывает её. Объединить с ней временную
              полку?{" "}
              {collision.works
                ? `Работы (${collision.works}) перейдут туда.`
                : "Работ на временной полке нет."}{" "}
              Временная полка закроется.
            </p>
            {collision.connections.length > 0 && (
              <fieldset className="claim-connections">
                <legend>
                  Какие агенты перенести? Отметьте только тех, кого подключали
                  вы сами и помните когда: имя агент выбирает себе сам.
                  Остальные будут отключены.
                </legend>
                {collision.connections.map((connection) => (
                  <label key={connection.id} className="claim-connection">
                    <input
                      type="checkbox"
                      checked={keep.includes(connection.id)}
                      disabled={busy !== null}
                      onChange={() =>
                        setKeep((current) =>
                          current.includes(connection.id)
                            ? current.filter((id) => id !== connection.id)
                            : [...current, connection.id],
                        )
                      }
                    />
                    <span>
                      <strong>{connection.name}</strong>
                      <small>
                        {connection.kind === "oauth" ? "вход через браузер" : "токен"}
                        {` · подключено ${new Date(connection.createdAt).toLocaleString("ru-RU")}`}
                        {connection.lastSeenAt
                          ? ` · последний раз ${new Date(connection.lastSeenAt).toLocaleString("ru-RU")}`
                          : " · запросов ещё не было"}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="shelf-choice">
              <Button
                variant="primary"
                busy={busy === "merge"}
                disabled={busy !== null}
                onClick={() => void act("merge")}
              >
                Объединить
              </Button>
              <Button
                busy={busy === "switch"}
                disabled={busy !== null}
                onClick={() => void act("switch")}
              >
                Открыть ту полку без объединения
              </Button>
              <Button
                variant="quiet"
                busy={busy === "cancel"}
                disabled={busy !== null}
                onClick={() => void act("cancel")}
              >
                Отмена
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1>Закрепите полку.</h1>
            <p>
              Сейчас полка живёт только в этом браузере и не выдаёт ссылки.
              Войдите {ways.with} — способ входа привяжется к этой же полке,
              работы и агенты останутся на месте.
            </p>
            {error && <Notice tone="error">{error}</Notice>}
            {loaded && weak && (
              <>
                <Notice>
                  Вы вошли по ссылке от агента. Чтобы закрепить полку, войдите
                  в свою полку (или создайте её) {ways.via} — затем работы этой
                  временной полки можно будет перенести туда.
                </Notice>
                <ProviderButtons providers={providers} next="/" />
                {emailLogin && (
                  <a
                    className="ui-button ui-button--secondary ui-button--block"
                    href={`/signup?${new URLSearchParams({ claim: "1", next: "/" })}`}
                  >
                    <Mail /> По почте
                  </a>
                )}
              </>
            )}
            {loaded && !weak && (
              <>
                <LinkProviderButtons providers={providers} onError={setError} />
                {emailLogin && (
                  <a
                    className="ui-button ui-button--secondary ui-button--block"
                    href={`/signup?${new URLSearchParams({ claim: "1", next })}`}
                  >
                    <Mail /> По почте
                  </a>
                )}
                <p className="onboard-fine">
                  По закону делиться ссылками можно после авторизации через
                  российские сервисы: войдите {ways.via} (почта — на российском
                  домене). Если этот способ уже открывает другую вашу полку,
                  предложим объединить.
                </p>
              </>
            )}
            <AskAgentHint
              lead="Потеряли вход в полку? Попросите агента:"
              tail="— он даст ссылку, которая откроет её в браузере."
            />
          </>
        )}
      </main>
    </AppShell>
  );
}
