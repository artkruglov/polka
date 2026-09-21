import { authReturnTo, safeNext } from "../../shared/lib/safe-next.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { Button, TextField } from "../../shared/ui/controls.tsx";
import "./styles.css";
import React, { useRef, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  Compass,
  Link2 as LinkIcon,
} from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { ErrorNotice } from "../../shared/ui/index.tsx";
export function Login({ onLogin }: { onLogin: (a: Account) => void }) {
  const [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const toFileSave = safeNext(
    new URLSearchParams(location.search).get("next"),
  )?.startsWith("/bring#file");
  return (
    <AppShell current="shelf" account={null} className="login-shell">
      <main className="login-page">
        <section className="login-intro">
          <span className="eyebrow">
            РАБОТЫ ИЗ CLAUDE, CHATGPT И ДРУГИХ АГЕНТОВ
          </span>
          <h1>
            Сделали в чате.
            <br />
            Сохранили на Полке.
            <br />
            <em>Отправили ссылкой.</em>
          </h1>
          <p>
            Каждую сохранённую работу видите только вы, пока сами
            <br />
            не поделитесь ссылкой или не опубликуете снимок.
          </p>
          <div className="intro-stack">
            <div>
              Трекер сна и привычек <ArrowUpRight />
            </div>
            <div>
              Калькулятор досрочного погашения <ArrowUpRight />
            </div>
            <div>
              Дроби на пицце <ArrowUpRight />
            </div>
          </div>
        </section>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (sending.current) return;
            sending.current = true;
            setBusy(true);
            setError("");
            try {
              await client.login(name, password);
              onLogin(await client.me());
            } catch (e) {
              setError((e as Error).message);
            } finally {
              sending.current = false;
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">ВАША ПОЛКА</span>
          <h2>С возвращением</h2>
          <a
            href={`/signup?next=${encodeURIComponent(authReturnTo(location))}`}
          >
            Войти по почте или создать свою полку →
          </a>
          <p className="muted">Войдите с аккаунтом этой установки.</p>
          {toFileSave && (
            <div className="login-intent" role="note">
              <Bookmark />
              <span>
                После входа вернём к <strong>сохранению файла</strong>.
                Выбранный до входа файл нужно будет выбрать ещё раз.
              </span>
            </div>
          )}
          <TextField
            label="Логин"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
          <TextField
            label="Пароль"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <ErrorNotice error={error} />
          <Button type="submit" variant="primary" busy={busy}>
            {busy
              ? "Входим…"
              : toFileSave
                ? "Войти и продолжить"
                : "Открыть Полку"}
            <ArrowUpRight />
          </Button>
          <a className="login-capture" href="/bring#file">
            <span>
              <LinkIcon /> Сохранить файл: HTML, текст или изображение
            </span>
            <ArrowUpRight />
          </a>
          <a className="login-explore" href="/discover">
            <Compass /> Публичные примеры без входа <ArrowUpRight />
          </a>
          <small>
            Локальная сборка. Аккаунт создаёт владелец установки; внешняя
            регистрация не нужна.
          </small>
        </form>
      </main>
    </AppShell>
  );
}
