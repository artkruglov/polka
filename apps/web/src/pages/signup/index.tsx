import "./styles.css";
import React, { useEffect, useState, useRef } from "react";
import { ArrowRight, KeyRound, Mail } from "lucide-react";
import { request } from "../../shared/api/client.ts";
import { loadCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { Button, TextField, Notice } from "../../shared/ui/controls.tsx";
import { PasswordLoginForm } from "../../features/password-login/index.tsx";
export function Signup() {
  const account = useAccount();
  const sending = useRef(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{
    id: string;
    delivery: string;
  } | null>(null);
  const [mode, setMode] = useState("loading");
  const [inviteOnly, setInviteOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const next =
    safeNext(new URLSearchParams(location.search).get("next")) || "/start";
  useEffect(() => {
    loadCapabilities()
      .then(async (c) => {
        setMode(c.emailLogin);
        setInviteOnly(c.emailSignup === "invite");
        if (c.emailLogin === "disabled") return;
        const pending = await request<{
          id: string;
          email: string;
          delivery: string;
          expiresAt: string;
          retryAfter: number;
          locked: boolean;
        } | null>("/auth/email/current");
        if (pending) {
          setEmail(pending.email);
          setChallenge(pending);
          setCooldown(pending.retryAfter);
          if (pending.locked)
            setError("Попытки закончились. Запросите новый код.");
        }
      })
      .catch(() => {
        setMode("error");
        setError("Не удалось связаться с Полкой. Обновите страницу.");
      });
  }, []);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  async function send() {
    if (
      sending.current ||
      mode === "loading" ||
      mode === "error" ||
      mode === "disabled"
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await request<{ id: string; delivery: string }>(
        "/auth/email/start",
        { email },
      );
      setChallenge(res);
      setCode("");
      setCooldown(60);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const passwordOnly = mode === "disabled";
  // Sent here by an agent's connection request (Codex, Claude Code, Claude.ai…).
  const forAgent = next.startsWith("/oauth/consent");
  return (
    <AppShell current="shelf" account={account}>
      <main className="onboard">
        <div className="onboard-icon">{passwordOnly ? <KeyRound /> : <Mail />}</div>
        <span className="eyebrow">
          {forAgent
            ? "Агент просит доступ к Полке"
            : passwordOnly
              ? "Вход в Полку"
              : "Своя полка за пару шагов"}
        </span>
        <h1>
          {mode === "loading"
            ? "Ваша личная полка."
            : passwordOnly
              ? "Войдите в Полку."
              : challenge
                ? "Проверьте почту."
                : "Ваша личная полка."}
        </h1>
        <p>
          {passwordOnly
            ? "Аккаунт выдаёт администратор этой Полки. Введите логин и пароль, которые вам передали, — регистрация на стороне не нужна."
            : challenge
              ? challenge.delivery === "local"
                ? "Код сохранён в локальном тестовом ящике. Настоящее письмо не отправлено."
                : inviteOnly
                  ? `Если адрес ${email} приглашён на эту Полку, код придёт в течение минуты. Он действует 10 минут.`
                  : `Отправили код на ${email}. Он действует 10 минут.`
              : inviteOnly
                ? "Вход по приглашению. Введите почту, на которую вас пригласили, — пришлём код."
                : "Войдите по почте. Если вы здесь впервые, создадим личную полку — без пароля и заполнения профиля."}
        </p>
        {forAgent && !challenge && !passwordOnly && mode !== "loading" && (
          <aside className="onboard-note">
            Войдите или создайте полку по почте. Сразу после этого Полка
            спросит, что разрешить агенту, — и подключение готово.
          </aside>
        )}
        {mode === "loading" && (
          <p className="entry-loading" role="status">
            Проверяем способы входа…
          </p>
        )}
        {mode === "local" && (
          <aside className="onboard-note">
            Локальная проверка: используйте адрес вроде author@example.test. Это
            не подтверждение реальной почты.
          </aside>
        )}
        {mode === "error" && (
          <Notice tone="error">
            {error}
            <Button type="button" onClick={() => location.reload()}>
              Попробовать снова
            </Button>
          </Notice>
        )}
        {passwordOnly ? (
          <div className="onboard-password">
            <PasswordLoginForm
              onLogin={() => {
                location.assign(next === "/start" ? "/" : next);
              }}
            />
            <p className="onboard-fine">
              Нет логина? Попросите администратора создать аккаунт: он выдаётся
              вручную, без публичной регистрации.
            </p>
          </div>
        ) : mode !== "loading" && mode !== "error" ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!challenge) return send();
              if (sending.current) return;
              sending.current = true;
              setBusy(true);
              setError("");
              try {
                await request("/auth/email/verify", { id: challenge.id, code });
                location.assign(next);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                sending.current = false;
                setBusy(false);
              }
            }}
          >
            {!challenge ? (
              <TextField
                label="Почта"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={
                  mode === "local" ? "author@example.test" : "you@company.ru"
                }
              />
            ) : (
              <>
                <TextField
                  label="Код из восьми цифр"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{8}"
                  maxLength={9}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
                {challenge.delivery === "local" && (
                  <p className="onboard-note">
                    Файл для разработчика:{" "}
                    <code>.local/mail/{challenge.id}.json</code>. Код доступен
                    на диске этого компьютера, не через публичный API.
                  </p>
                )}
              </>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy
                ? "Пожалуйста, подождите…"
                : challenge
                  ? "Открыть мою полку"
                  : "Получить код"}
              <ArrowRight size={17} />
            </Button>
            {challenge && (
              <div className="onboard-secondary">
                <Button
                  type="button"
                  disabled={busy || cooldown > 0}
                  onClick={send}
                >
                  {cooldown
                    ? `Повторить через ${cooldown} с`
                    : "Отправить новый код"}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setChallenge(null);
                    setError("");
                  }}
                >
                  Другая почта
                </Button>
              </div>
            )}
          </form>
        ) : null}
        {!passwordOnly && mode !== "loading" && (
          <a
            className="onboard-legacy"
            href={`/?login=1&next=${encodeURIComponent(next)}`}
          >
            <KeyRound size={15} /> Есть логин и пароль этой Полки
          </a>
        )}
      </main>
    </AppShell>
  );
}
