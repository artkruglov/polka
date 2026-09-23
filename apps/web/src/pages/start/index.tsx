import "./styles.css";
import React from "react";
import { ArrowUpRight, Link2 } from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { FirstRunChecklist } from "../../features/first-run/index.tsx";
import { LinkButton } from "../../shared/ui/controls.tsx";

/** After sign-up: what Полка is in one sentence, then the three first-run steps. */
export function FirstSave() {
  const account = useAccount();
  const imports = useCapabilities();
  const canImport = imports.status === "ready" && imports.capabilities.urlImport;
  return (
    <AppShell current="shelf" account={account}>
      <main className="start-main">
        <header className="start-heading">
          <span className="eyebrow">Ваша полка создана</span>
          <h1>
            Первая работа —<br />
            за две минуты.
          </h1>
          <p>
            Полка хранит страницы, отчёты и прототипы, которые вы делаете с
            агентом: каждую — версиями, с ссылкой, которую получатель откроет
            без аккаунта и которую вы закроете, когда захотите.
          </p>
        </header>
        {account ? (
          <FirstRunChecklist account={account} variant="page" />
        ) : account === null ? (
          <p className="start-note" role="status">
            Чтобы начать, <a href={`/signup?next=${encodeURIComponent("/start")}`}>войдите в Полку</a>.
          </p>
        ) : (
          <p className="start-note" role="status">
            Открываем полку…
          </p>
        )}
        <div className="start-footer">
          <LinkButton href="/" variant="secondary">
            Перейти на полку <ArrowUpRight />
          </LinkButton>
          <a className="start-link" href="/discover">
            Посмотреть примеры работ <ArrowUpRight />
          </a>
          {canImport && (
            <a className="start-link" href="/bring?url=">
              <Link2 /> Есть ссылка на публичную HTML-страницу? Сохраните копию
            </a>
          )}
        </div>
      </main>
    </AppShell>
  );
}
