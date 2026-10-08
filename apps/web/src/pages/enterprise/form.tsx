import React, { useState } from "react";
import { CircleCheck, Send } from "lucide-react";
import {
  ENTERPRISE_INTERESTS,
  ENTERPRISE_LIMITS,
  type EnterpriseInterest,
} from "../../../../../packages/contracts/constants.ts";
import { ApiError, request } from "../../shared/api/client.ts";
import { Button, TextAreaField, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";

export const CONTACT = "hello@polochka.app";

/** /enterprise?interest=commercial-license preselects what the person wants. */
export function initialInterest(search: string): EnterpriseInterest | "" {
  const value = new URLSearchParams(search).get("interest");
  return (ENTERPRISE_INTERESTS as readonly string[]).includes(value ?? "")
    ? (value as EnterpriseInterest)
    : "";
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "00000000-0000-4000-8000-000000000000";

type Fields = {
  contact: string;
  comment: string;
  policyRead: boolean;
  website: string;
};
const EMPTY: Fields = { contact: "", comment: "", policyRead: false, website: "" };

/**
 * The request is one field — a work e-mail or a Telegram name — and a button.
 * What the person wants comes from the button they pressed on the page; a
 * comment is optional.
 */
export function EnterpriseForm({
  interest,
  onInterest,
  initialSent = null,
}: {
  interest: EnterpriseInterest | "";
  onInterest: (value: EnterpriseInterest | "") => void;
  /** Tests render the success state directly. */
  initialSent?: { contact: string } | null;
}) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  // One key per filled form: a retry after a network error is the same request.
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(initialSent);
  const set =
    <K extends keyof Fields>(name: K) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const target = event.target as HTMLInputElement;
      setFields((current) => ({
        ...current,
        [name]: target.type === "checkbox" ? target.checked : target.value,
      }));
    };

  if (sent) {
    const telegram = sent.contact.startsWith("@");
    return (
      <div className="enterprise-sent" role="status">
        <CircleCheck aria-hidden="true" />
        <h3>Заявка отправлена</h3>
        <p>
          Спасибо! {telegram ? "Напишем в Telegram" : "Ответим на"}{" "}
          <strong>{sent.contact}</strong>. Если долго нет ответа, напишите на{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
        <Button
          onClick={() => {
            setFields(EMPTY);
            setKey(newKey());
            onInterest("");
            setSent(null);
          }}
        >
          Отправить ещё одну
        </Button>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const answer = await request<{ ok: true; contact?: string }>(
        "/enterprise-requests",
        {
          key,
          contact: fields.contact,
          ...(interest ? { interest } : {}),
          ...(fields.comment.trim() ? { comment: fields.comment } : {}),
          policyRead: fields.policyRead,
          ...(fields.website ? { website: fields.website } : {}),
        },
      );
      setSent({ contact: answer.contact ?? fields.contact.trim() });
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "invalid"
          ? "Укажите рабочую почту или имя в Telegram, например anna@company.ru или @anna."
          : e instanceof Error
            ? e.message
            : "Не удалось отправить заявку.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="enterprise-form" onSubmit={submit}>
      <div className="enterprise-quick">
        <TextField
          label="Почта или Telegram"
          name="contact"
          autoComplete="email"
          required
          maxLength={ENTERPRISE_LIMITS.email}
          placeholder="anna@company.ru или @anna"
          value={fields.contact}
          onChange={set("contact")}
        />
        <Button type="submit" variant="primary" busy={busy}>
          Попросить пилот <Send size={17} />
        </Button>
      </div>
      <input type="hidden" name="interest" value={interest} />
      <details className="enterprise-more">
        <summary>Добавить пару слов</summary>
        <TextAreaField
          label="Комментарий"
          name="comment"
          rows={3}
          maxLength={ENTERPRISE_LIMITS.comment}
          hint="Необязательно: задача, сколько человек, сроки."
          value={fields.comment}
          onChange={set("comment")}
        />
      </details>
      {/* Honeypot: people never see or reach it; bots fill every field. */}
      <div className="enterprise-trap" aria-hidden="true">
        <label>
          Сайт
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={fields.website}
            onChange={set("website")}
          />
        </label>
      </div>
      <label className="enterprise-policy">
        <input
          type="checkbox"
          name="policyRead"
          required
          checked={fields.policyRead}
          onChange={set("policyRead")}
        />
        <span>
          Я прочитал(а){" "}
          <a href="/privacy" target="_blank" rel="noopener">
            Политику обработки персональных данных
          </a>
          . Контакт нужен, чтобы ответить, и хранится год.
        </span>
      </label>
      <ErrorNotice error={error} />
    </form>
  );
}
