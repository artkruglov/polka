import React, { useState } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import type { Account } from "../../../packages/contracts/index.ts";
import { client } from "./client.ts";
import { Brand, ErrorNotice } from "./ui.tsx";
export function Login({ onLogin }: { onLogin: (a: Account) => void }) {
  const [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <Brand />
      <section className="login-intro">
        <span className="eyebrow">МЕСТО ДЛЯ ХОРОШИХ РАБОТ</span>
        <h1>
          Сохранить.
          <br />
          Поделиться.
          <br />
          <em>Вернуться к идее.</em>
        </h1>
        <p>
          Ваши материалы, их версии и ссылки —<br />
          на одной полке.
        </p>
        <div className="intro-stack">
          <div>
            Год в цифрах <ArrowUpRight />
          </div>
          <div>
            Идеи для запуска <FileText />
          </div>
          <div>
            Следующий большой шаг <ArrowUpRight />
          </div>
        </div>
      </section>
      <form
        className="login-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await client.login(name, password);
            onLogin(await client.me());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">ВАША ЛИЧНАЯ ПОЛКА</span>
        <h2>С возвращением</h2>
        <p className="muted">Войдите с аккаунтом этой установки.</p>
        <label>
          Логин
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <ErrorNotice error={error} />
        <button className="primary" disabled={busy}>
          {busy ? "Входим…" : "Открыть полку"}
          <ArrowUpRight />
        </button>
        <small>
          Локальная сборка. Аккаунт создаёт владелец установки; внешняя
          регистрация не нужна.
        </small>
      </form>
    </div>
  );
}
