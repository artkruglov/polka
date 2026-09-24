import React, { useEffect, useState } from "react";
import { Mail, ShieldCheck } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { AskAgentHint } from "../../shared/ui/AskAgentHint.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { loadCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";
import {
  LinkProviderButtons,
  providerErrorMessage,
} from "../../features/provider-sign-in/index.tsx";

type Collision = {
  method: string;
  methodName: string;
  targetName: string;
  works: number;
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
  useEffect(() => {
    if (account === null)
      location.replace(`/signup?${new URLSearchParams({ next: "/" })}`);
    if (!account) return;
    Promise.all([
      loadCapabilities(),
      request<{ provisional: boolean; collision: Collision | null }>(
        "/account/claim",
      ),
    ])
      .then(([capabilities, claim]) => {
        setProviders(capabilities.signInProviders);
        setEmailLogin(capabilities.emailLogin !== "disabled");
        setCollision(claim.collision);
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
      await request(`/account/claim/${kind}`, {});
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
                ? `Работы (${collision.works}) и подключённые агенты перейдут туда, ссылки сохранятся.`
                : "Подключённые агенты перейдут туда."}{" "}
              Временная полка закроется.
            </p>
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
              Войдите с Яндекс ID{providers.some((p) => p.id === "vk") ? ", VK ID" : ""}{" "}
              или подтвердите почту — способ входа привяжется к этой же полке,
              работы и агенты останутся на месте.
            </p>
            {error && <Notice tone="error">{error}</Notice>}
            {loaded && (
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
                  По закону авторизация — через российские сервисы: Яндекс ID,
                  VK ID или почту на российском домене. Если этот способ уже
                  открывает другую вашу полку, предложим объединить.
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
