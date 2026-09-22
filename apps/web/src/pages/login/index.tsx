import { authReturnTo, safeNext } from "../../shared/lib/safe-next.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { PasswordLoginForm } from "../../features/password-login/index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { Wave } from "../../shared/ui/Wave.tsx";
import "./styles.css";
import React from "react";
import {
  ArrowUpRight,
  Bookmark,
  Bot,
  Compass,
  FileUp,
  History,
  Link2,
  Mail,
} from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
export function Login({ onLogin }: { onLogin: (a: Account) => void }) {
  const capabilities = useCapabilities();
  const emailLogin =
    capabilities.status === "ready" &&
    capabilities.capabilities.emailLogin !== "disabled";
  const toFileSave = safeNext(
    new URLSearchParams(location.search).get("next"),
  )?.startsWith("/bring#file");
  return (
    <AppShell current="shelf" account={null} className="login-shell">
      <main className="login-page">
        <section className="login-intro">
          <span className="eyebrow">Работы из Claude, ChatGPT и других агентов</span>
          <h1>
            Сделали в чате.
            <br />
            Сохранили на Полке.
            <br />
            <em>Отправили ссылкой.</em>
          </h1>
          <p>
            Каждую сохранённую работу видите только вы, пока сами не поделитесь
            ссылкой.
          </p>
          <Wave compact className="login-wave" />
          <ul className="login-points">
            <li>
              <Link2 /> Ссылка, которую можно отозвать в любой момент
            </li>
            <li>
              <History /> История версий: новая версия не ломает отправленную ссылку
            </li>
            <li>
              <Bot /> Агент сохраняет работы сам — через MCP
            </li>
          </ul>
        </section>
        <section className="login-form" aria-labelledby="login-title">
          <span className="eyebrow">Ваша полка</span>
          <h2 id="login-title">С возвращением</h2>
          <p className="muted">
            Аккаунт выдаёт администратор этой Полки. Войдите с логином и
            паролем, которые вам передали.
          </p>
          <PasswordLoginForm
            onLogin={onLogin}
            submitLabel={toFileSave ? "Войти и продолжить" : "Открыть Полку"}
          >
            {toFileSave && (
              <div className="login-intent" role="note">
                <Bookmark />
                <span>
                  После входа вернём к <strong>сохранению файла</strong>.
                  Выбранный до входа файл нужно будет выбрать ещё раз.
                </span>
              </div>
            )}
          </PasswordLoginForm>
          {emailLogin && (
            <a
              className="login-email"
              href={`/signup?next=${encodeURIComponent(authReturnTo(location))}`}
            >
              <Mail /> Войти по почте или создать свою полку <ArrowUpRight />
            </a>
          )}
          <div className="login-else">
            <LinkButton href="/bring#file" variant="secondary">
              <FileUp /> Сохранить файл без входа
            </LinkButton>
            <a className="login-explore" href="/discover">
              <Compass /> Публичные примеры <ArrowUpRight />
            </a>
          </div>
          <small>
            Нет логина? Попросите администратора создать аккаунт — публичной
            регистрации здесь нет.
          </small>
        </section>
      </main>
    </AppShell>
  );
}
