import React, { useState } from "react";
import { CircleCheck, Send } from "lucide-react";
import {
  ENTERPRISE_INTERESTS,
  ENTERPRISE_LIMITS,
  ENTERPRISE_TEAM_SIZES,
  type EnterpriseInterest,
  type EnterpriseTeamSize,
} from "../../../../../packages/contracts/constants.ts";
import { ApiError, request } from "../../shared/api/client.ts";
import {
  Button,
  SelectField,
  TextAreaField,
  TextField,
} from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";

export const CONTACT = "hello@polochka.app";

export const TEAM_SIZES: Record<EnterpriseTeamSize, string> = {
  "1-10": "До 10 человек",
  "11-50": "11–50",
  "51-200": "51–200",
  "201-1000": "201–1000",
  "1000+": "Больше 1000",
};
export const INTERESTS: Record<EnterpriseInterest, string> = {
  cloud: "Облако polochka.app",
  "self-hosted": "Своя установка",
  "commercial-license": "Коммерческая лицензия",
  other: "Другое",
};

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
  name: string;
  company: string;
  email: string;
  teamSize: EnterpriseTeamSize | "";
  comment: string;
  policyRead: boolean;
  website: string;
};
const EMPTY: Fields = {
  name: "",
  company: "",
  email: "",
  teamSize: "",
  comment: "",
  policyRead: false,
  website: "",
};

export function EnterpriseForm({
  interest,
  onInterest,
  initialSent = null,
}: {
  interest: EnterpriseInterest | "";
  onInterest: (value: EnterpriseInterest | "") => void;
  /** Tests render the success state directly. */
  initialSent?: { name: string; email: string } | null;
}) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  // One key per filled form: a retry after a network error is the same request.
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(initialSent);
  const set =
    <K extends keyof Fields>(name: K) =>
    (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => {
      const target = event.target as HTMLInputElement;
      setFields((current) => ({
        ...current,
        [name]: target.type === "checkbox" ? target.checked : target.value,
      }));
    };

  if (sent)
    return (
      <div className="enterprise-sent" role="status">
        <CircleCheck aria-hidden="true" />
        <h3>Заявка отправлена</h3>
        <p>
          Спасибо, {sent.name}. Ответим на <strong>{sent.email}</strong>. Если
          письма долго нет, напишите на{" "}
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request("/enterprise-requests", {
        key,
        name: fields.name,
        company: fields.company,
        email: fields.email,
        teamSize: fields.teamSize,
        interest,
        ...(fields.comment.trim() ? { comment: fields.comment } : {}),
        policyRead: fields.policyRead,
        ...(fields.website ? { website: fields.website } : {}),
      });
      setSent({ name: fields.name.trim(), email: fields.email.trim() });
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "invalid"
          ? "Проверьте поля: имя, компания, почта, размер команды и что вас интересует обязательны."
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
      <div className="enterprise-form-row">
        <TextField
          label="Имя"
          name="name"
          autoComplete="name"
          required
          maxLength={ENTERPRISE_LIMITS.name}
          value={fields.name}
          onChange={set("name")}
        />
        <TextField
          label="Компания"
          name="company"
          autoComplete="organization"
          required
          maxLength={ENTERPRISE_LIMITS.company}
          value={fields.company}
          onChange={set("company")}
        />
      </div>
      <TextField
        label="Рабочая почта"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={ENTERPRISE_LIMITS.email}
        hint="На неё придёт ответ."
        value={fields.email}
        onChange={set("email")}
      />
      <div className="enterprise-form-row">
        <SelectField
          label="Размер команды"
          name="teamSize"
          required
          value={fields.teamSize}
          onChange={set("teamSize")}
        >
          <option value="" disabled>
            Выберите
          </option>
          {ENTERPRISE_TEAM_SIZES.map((size) => (
            <option key={size} value={size}>
              {TEAM_SIZES[size]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Что хотите"
          name="interest"
          required
          value={interest}
          onChange={(event) =>
            onInterest(event.target.value as EnterpriseInterest)
          }
        >
          <option value="" disabled>
            Выберите
          </option>
          {ENTERPRISE_INTERESTS.map((value) => (
            <option key={value} value={value}>
              {INTERESTS[value]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextAreaField
        label="Комментарий"
        name="comment"
        rows={4}
        maxLength={ENTERPRISE_LIMITS.comment}
        hint={`Необязательно. Задача, сроки, требования к данным — до ${ENTERPRISE_LIMITS.comment} символов.`}
        value={fields.comment}
        onChange={set("comment")}
      />
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
          . Данные из заявки нужны, чтобы ответить на неё, и хранятся год.
        </span>
      </label>
      <ErrorNotice error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        Отправить заявку <Send size={17} />
      </Button>
    </form>
  );
}
