import React, { useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { rememberSignInMethod } from "../../shared/lib/known-shelf.ts";
import { Button, TextField, Notice } from "../../shared/ui/controls.tsx";

/**
 * Login with an account issued by the administrator of this installation.
 * The page decides where to go afterwards; the form only authenticates.
 */
export function PasswordLoginForm({
  onLogin,
  submitLabel = "Открыть Полку",
  children,
}: {
  onLogin: (account: Account) => void | Promise<void>;
  submitLabel?: string;
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  return (
    <form
      className="password-login"
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current) return;
        sending.current = true;
        setBusy(true);
        setError("");
        try {
          rememberSignInMethod("password");
          const result = (await client.login(name, password)) as {
            collision?: boolean;
          };
          // A provisional shelf in this browser met this login's shelf:
          // /claim asks whether to merge them.
          if (result?.collision) {
            location.assign("/claim?collision=1");
            return;
          }
          await onLogin(await client.me());
        } catch (e) {
          setError((e as Error).message);
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      {children}
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
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy}>
        {busy ? "Входим…" : submitLabel}
        {!busy && <ArrowUpRight />}
      </Button>
    </form>
  );
}
