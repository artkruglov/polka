import React, { useEffect, useState, useRef } from "react";
import { ArrowRight, KeyRound, Mail } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import {
  knownShelf,
  rememberSignInMethod,
} from "../../shared/lib/known-shelf.ts";
import { AskAgentHint } from "../../shared/ui/AskAgentHint.tsx";
import { loadCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { visitSource } from "../../shared/lib/visit-source.ts";
import { Button, TextField, Notice } from "../../shared/ui/controls.tsx";
import { PasswordLoginForm } from "../../features/password-login/index.tsx";
import { SignupConsent } from "./consent.tsx";
import {
  OutsideDomainHelp,
  SPAM_HINT,
  codeScreenNotice,
  outsideSignupDomains,
  signupDomainsPhrase,
  typedDomainOf,
} from "./code-help.tsx";
import {
  ProviderButtons,
  providerErrorMessage,
} from "../../features/provider-sign-in/index.tsx";
import type { SignInProvider } from "../../entities/capabilities/useCapabilities.ts";
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
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [signupDomains, setSignupDomains] = useState<"any" | string[]>("any");
  const [loginDomains, setLoginDomains] = useState<"any" | "signup">("any");
  const query = new URLSearchParams(location.search);
  const [error, setError] = useState(
    providerErrorMessage(query.get("idp_error")) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const next =
    safeNext(query.get("next")) || "/start";
  // /signup/choose → «Войти в существующую полку»: after this sign-in the
  // waiting provider is linked to the shelf (docs/specs/SIGN_IN_PROVIDERS.md § 1).
  const linking = query.get("link") === "pending";
  const hint = knownShelf();
  // A code for an address without a shelf, in a browser that knows one.
  const [askNew, setAskNew] = useState(false);
  // A provisional shelf is claimed on /claim; this page is its email step.
  useEffect(() => {
    if (account?.provisional && query.get("claim") !== "1")
      location.replace(`/claim?${new URLSearchParams({ next })}`);
  }, [account]);
  useEffect(() => {
    loadCapabilities()
      .then(async (c) => {
        setMode(c.emailLogin);
        setInviteOnly(c.emailSignup === "invite");
        setProviders(c.signInProviders);
        setSignupDomains(c.emailSignupDomains);
        setLoginDomains(c.emailLoginDomains);
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
  async function verify(createNew: boolean) {
    if (!challenge || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const source = visitSource();
      rememberSignInMethod("email");
      const result = await request<{
        claimed?: boolean;
        collision?: boolean;
      }>("/auth/email/verify", {
        id: challenge.id,
        code,
        ...(source ? { source } : {}),
        // The browser remembers a shelf: ask before opening another.
        ...(hint || linking ? { knownShelf: true } : {}),
        ...(createNew ? { createNew: true } : {}),
      });
      if (result.collision) location.assign("/claim?collision=1");
      else location.assign(result.claimed ? "/?claimed=1" : next);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.details.reason === "new_shelf"
      )
        setAskNew(true);
      else setError((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const passwordOnly = mode === "disabled";
  // The domain rule is public; the server answers the same either way, so
  // only the interface can say in advance why a code may not come.
  const typedDomain = typedDomainOf(email);
  const outsideDomains = outsideSignupDomains(typedDomain, signupDomains);
  // After «Получить код» too: the code screen keeps saying why it may not come.
  const codeNotice = challenge
    ? codeScreenNotice({
        email,
        delivery: challenge.delivery,
        inviteOnly,
        signupDomains,
        loginDomains,
      })
    : null;
  const changeAddress = () => {
    setChallenge(null);
    setCode("");
    setError("");
  };
  const providerNames = providers
    .filter((p) => p.id !== "oidc" && p.signup)
    .map((p) => p.name)
    .join(" или ");
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
            ? providers.length
              ? "Войдите одним нажатием или логином и паролем, которые выдал администратор этой Полки."
              : "Аккаунт выдаёт администратор этой Полки. Введите логин и пароль, которые вам передали, — регистрация на стороне не нужна."
            : challenge
              ? challenge.delivery === "local"
                ? "Код сохранён в локальном тестовом ящике. Настоящее письмо не отправлено."
                : codeNotice?.kind === "never"
                ? `Код на ${email} не придёт.`
                : outsideDomains && !inviteOnly
                ? `Если у адреса ${email} уже есть полка, код придёт в течение минуты. Он действует 10 минут.`
                : inviteOnly
                  ? `Если адрес ${email} приглашён на эту Полку, код придёт в течение минуты. Он действует 10 минут.`
                  : `Отправили код на ${email}. Он действует 10 минут.`
              : inviteOnly
                ? "Вход по приглашению. Введите почту, на которую вас пригласили, — пришлём код."
                : providers.length
                  ? "Войдите одним нажатием или по почте. Если вы здесь впервые, создадим личную полку — без пароля и заполнения профиля."
                  : "Войдите по почте. Если вы здесь впервые, создадим личную полку — без пароля и заполнения профиля."}
        </p>
        {!challenge && mode !== "loading" && providers.length > 0 && (
          <>
            {passwordOnly && error && <Notice tone="error">{error}</Notice>}
            <ProviderButtons providers={providers} next={next} />
            {mode !== "error" && (
              <div className="idp-or">{passwordOnly ? "или" : "или по почте"}</div>
            )}
          </>
        )}
        {forAgent && !challenge && !passwordOnly && mode !== "loading" && (
          <aside className="onboard-note">
            Войдите или создайте полку{providers.length ? "" : " по почте"}.
            Сразу после этого Полка спросит, что разрешить агенту, — и
            подключение готово.
          </aside>
        )}
        {linking && (
          <aside className="onboard-note">
            Войдите в свою полку{hint ? ` «${hint.displayName}»` : ""} любым
            способом — сразу после входа привяжем к ней новый способ входа.
          </aside>
        )}
        {account?.provisional && (
          <aside className="onboard-note">
            Адрес закрепит вашу временную полку: он станет способом входа, и
            полкой можно будет делиться.
          </aside>
        )}
        {askNew && (
          <section className="shelf-where" aria-live="polite">
            <strong>
              Похоже, у вас уже есть полка
              {hint ? ` «${hint.displayName}»` : ""}.
            </strong>{" "}
            На {email} полки нет. Войдите в существующую — или создайте
            новую полку на этот адрес.
            <div className="shelf-choice">
              <Button
                variant="primary"
                onClick={() => {
                  setAskNew(false);
                  setChallenge(null);
                  setEmail("");
                  setCode("");
                }}
              >
                Войти в существующую полку
              </Button>
              <Button disabled={busy} onClick={() => void verify(true)}>
                Создать новую полку
              </Button>
            </div>
          </section>
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
        ) : null}
        {!passwordOnly && codeNotice && !askNew && (
          <OutsideDomainHelp
            notice={codeNotice}
            providers={providers}
            next={next}
            busy={busy}
            onChangeAddress={changeAddress}
          />
        )}
        {passwordOnly ? null : mode !== "loading" &&
          mode !== "error" &&
          !askNew &&
          codeNotice?.kind !== "never" ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!challenge) return send();
              await verify(false);
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
                {challenge.delivery !== "local" && (
                  <p className="onboard-fine code-spam-hint">{SPAM_HINT}</p>
                )}
                {challenge.delivery === "local" && (
                  <p className="onboard-note">
                    Файл для разработчика:{" "}
                    <code>.local/mail/{challenge.id}.json</code>. Код доступен
                    на диске этого компьютера, не через публичный API.
                  </p>
                )}
              </>
            )}
            {!challenge && outsideDomains && !inviteOnly && (
              <Notice>
                {loginDomains === "signup"
                  ? `Код на адреса ${typedDomain} на этой Полке не отправляется.`
                  : `Новые полки по почте открываются ${signupDomainsPhrase(signupDomains)}. Если на ${typedDomain} полки у вас ещё нет, код не придёт.`}
                {providerNames
                  ? ` Войдите с ${providerNames} — полка откроется сразу.`
                  : ""}
              </Notice>
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
                {!codeNotice && (
                  <Button type="button" disabled={busy} onClick={changeAddress}>
                    Изменить адрес
                  </Button>
                )}
              </div>
            )}
          </form>
        ) : null}
        {!passwordOnly && mode !== "loading" && mode !== "error" && (
          <SignupConsent />
        )}
        {mode !== "loading" && !account?.provisional && <AskAgentHint />}
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
