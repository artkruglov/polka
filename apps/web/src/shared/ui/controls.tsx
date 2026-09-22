import React, { useId } from "react";

type ButtonVariant = "primary" | "secondary" | "quiet";

/** Navigation keeps native link behavior, including opening in a new tab. */
export function LinkButton({
  variant = "secondary",
  className = "",
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: ButtonVariant;
}) {
  return <a {...props} className={`ui-button ui-button--${variant} ${className}`} />;
}

export function SelectField({
  label,
  hint,
  error,
  id,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generated = useId(),
    fieldId = id ?? generated;
  const described =
    [
      props["aria-describedby"],
      hint ? `${fieldId}-hint` : null,
      error ? `${fieldId}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="ui-field">
      <label htmlFor={fieldId}>{label}</label>
      <select
        {...props}
        id={fieldId}
        className={`ui-input ${props.className ?? ""}`}
        aria-describedby={described}
        aria-invalid={error ? true : props["aria-invalid"]}
      >
        {children}
      </select>
      {hint && (
        <p className="ui-field-hint" id={`${fieldId}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="ui-field-error" id={`${fieldId}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
  onDismiss,
}: {
  children: React.ReactNode;
  tone?: "info" | "error";
  onDismiss?: () => void;
}) {
  return (
    <div
      className={`ui-notice ui-notice--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <div>{children}</div>
      {onDismiss && (
        <Button
          variant="quiet"
          onClick={onDismiss}
          aria-label="Скрыть уведомление"
        >
          Скрыть
        </Button>
      )}
    </div>
  );
}

export function StatusPanel({
  title,
  children,
  action,
  compact = false,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section
      className={`ui-status-panel${compact ? " ui-status-panel--compact" : ""}`}
    >
      <strong>{title}</strong>
      <p>{children}</p>
      {action && <div className="ui-status-panel-action">{action}</div>}
    </section>
  );
}

export function Button({
  variant = "secondary",
  busy = false,
  children,
  disabled,
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & React.RefAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-button ui-button--${variant} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span aria-hidden="true" className="ui-spinner" />}
      {children}
    </button>
  );
}
export function TextField({
  label,
  hint,
  error,
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const description =
    [
      props["aria-describedby"],
      hint ? `${inputId}-hint` : null,
      error ? `${inputId}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="ui-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        {...props}
        id={inputId}
        className={`ui-input ${props.className ?? ""}`}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={description}
      />
      {hint && (
        <p id={`${inputId}-hint`} className="ui-field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} className="ui-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function TextAreaField({
  label,
  hint,
  error,
  id,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const description =
    [
      props["aria-describedby"],
      hint ? `${inputId}-hint` : null,
      error ? `${inputId}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="ui-field">
      <label htmlFor={inputId}>{label}</label>
      <textarea
        {...props}
        id={inputId}
        className={`ui-input ${props.className ?? ""}`}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={description}
      />
      {hint && (
        <p id={`${inputId}-hint`} className="ui-field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} className="ui-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="ui-empty">
      <h2>{title}</h2>
      {children && <div>{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </section>
  );
}

export function Badge({tone = "neutral", className = "", ...props}: React.HTMLAttributes<HTMLSpanElement> & {tone?: "neutral" | "success" | "warning" | "danger" | "accent"}) {
  return <span {...props} className={`ui-badge ui-badge--${tone} ${className}`} />;
}

/** Icon-only action with a required accessible name. */
export function IconButton({
  label,
  variant = "quiet",
  size,
  className = "",
  children,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> &
  React.RefAttributes<HTMLButtonElement> & {
    label: string;
    variant?: "quiet" | "outline";
    size?: "sm";
    children: React.ReactNode;
  }) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={`ui-icon-button${variant === "outline" ? " ui-icon-button--outline" : ""}${size === "sm" ? " ui-icon-button--sm" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

/** A filter pill; `pressed` marks the active category. */
export function Chip({
  pressed = false,
  count,
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed?: boolean;
  count?: number;
}) {
  return (
    <button type="button" {...props} aria-pressed={pressed} className={`ui-chip ${className}`}>
      {children}
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}

/** Exclusive options rendered as one control (grid/list, file/text). */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  wide = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { id: T; label: React.ReactNode; title?: string }[];
  wide?: boolean;
}) {
  return (
    <div className={`ui-segmented${wide ? " ui-segmented--wide" : ""}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          aria-label={option.title}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Initials on a soft disc. */
export function Avatar({ name, size, className = "" }: { name: string; size?: "sm" | "lg"; className?: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("");
  return (
    <span className={`ui-avatar${size ? ` ui-avatar--${size}` : ""} ${className}`} aria-hidden="true">
      {initials || "•"}
    </span>
  );
}

/** A radio option with a title and explanation; the whole card is the target. */
export function ChoiceCard({
  name,
  value,
  checked,
  disabled = false,
  icon,
  title,
  description,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ui-choice" data-selected={checked} data-disabled={disabled || undefined}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} />
      {icon ?? <span />}
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}
