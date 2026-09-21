import React, { useEffect, useState, useRef } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Mail,
  Bot,
  Link2,
  FileUp,
} from "lucide-react";
import { request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { Button, TextField, Notice } from "../../shared/ui/controls.tsx";
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const next =
    safeNext(new URLSearchParams(location.search).get("next")) || "/start";
  useEffect(() => {
    request<{ emailLogin: string }>("/capabilities")
      .then(async (c) => {
        setMode(c.emailLogin || "disabled");
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
  return (
    <AppShell
      current="shelf"
      account={account}
      className="p-modern entry-redesign signup-redesign"
    >
      <main className="onboard">
        <div className="onboard-icon">
          <Mail />
        </div>
        <span className="p-eyebrow">СВОЯ ПОЛКА ЗА ПАРУ ШАГОВ</span>
        <h1>{challenge ? "Проверьте почту." : "Ваша личная полка."}</h1>
        <p>
          {challenge
            ? challenge.delivery === "local"
              ? "Код сохранён в локальном тестовом ящике. Настоящее письмо не отправлено."
              : `Отправили код на ${email}. Он действует 10 минут.`
            : "Войдите по почте. Если вы здесь впервые, создадим личную полку — без пароля и заполнения профиля."}
        </p>
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
        {mode === "disabled" ? (
          <aside className="onboard-note">
            Доставка кодов ещё не настроена.{" "}
            <a href={`/?login=1&next=${encodeURIComponent(next)}`}>
              Войти с аккаунтом установки
            </a>
          </aside>
        ) : (
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
                  label="Код из шести цифр"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
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
            {error && (
              <Notice tone="error">
                {error}
                {mode === "error" && (
                  <Button type="button" onClick={() => location.reload()}>
                    Попробовать снова
                  </Button>
                )}
              </Notice>
            )}
            <Button
              variant="primary"
              type="submit"
              disabled={busy || mode === "loading" || mode === "error"}
            >
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
        )}
        <a
          className="onboard-legacy"
          href={`/?login=1&next=${encodeURIComponent(next)}`}
        >
          Есть логин и пароль этой установки
        </a>
      </main>
    </AppShell>
  );
}
