import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./controls.tsx";

type CopyState = "idle" | "copying" | "copied" | "failed";
const clipboard = (text: string) => navigator.clipboard.writeText(text);

/**
 * Clipboard state for one value. «Скопировано» belongs to the value that was
 * copied: a new value starts idle, and a late result for an old value is ignored.
 */
export function useCopy(
  value: string,
  writeText: (text: string) => Promise<void> = clipboard,
) {
  const [result, setResult] = useState<{
    value: string;
    state: CopyState;
  } | null>(null);
  const state: CopyState = result?.value === value ? result.state : "idle";
  const currentValue = useRef(value);
  currentValue.current = value;
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const copy = async () => {
    const request = ++attempt.current;
    setResult({ value, state: "copying" });
    let next: CopyState = "copied";
    try {
      await writeText(value);
    } catch {
      next = "failed";
    }
    // A late answer for a value that is no longer shown changes nothing.
    if (request !== attempt.current || currentValue.current !== value)
      return null;
    setResult({ value, state: next });
    return next;
  };
  return { state, copy };
}

/** A copy action whose text is shown elsewhere (a link, a command). */
export function CopyButton({
  value,
  label = "Скопировать",
  successText = "Скопировано",
  variant = "secondary",
  className,
  writeText,
}: {
  value: string;
  label?: string;
  successText?: string;
  variant?: "primary" | "secondary" | "quiet";
  className?: string;
  writeText?: (text: string) => Promise<void>;
}) {
  const { state, copy } = useCopy(value, writeText);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        busy={state === "copying"}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check /> : <Copy />}{" "}
        {state === "copied" ? successText : label}
      </Button>
      {state === "failed" && (
        <span className="field-note" role="status">
          Браузер не дал скопировать — выделите текст вручную.
        </span>
      )}
    </>
  );
}

/** Read-only text with a copy action; on failure the text is selected for manual copy. */
export function CopyText({
  value,
  label,
  rows = 4,
  buttonLabel = "Скопировать",
  successText = "Скопировано",
  collapsible = false,
  buttonVariant,
  writeText,
}: {
  value: string;
  label: string;
  rows?: number;
  buttonLabel?: string;
  successText?: string;
  collapsible?: boolean;
  buttonVariant?: "primary" | "secondary";
  writeText?: (text: string) => Promise<void>;
}) {
  const { state, copy } = useCopy(value, writeText);
  const area = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLDetailsElement>(null);
  const text = (
    <textarea
      ref={area}
      readOnly
      value={value}
      rows={rows}
      aria-label={label}
    />
  );
  return (
    <div className="copy-text">
      {collapsible ? (
        <details ref={preview}>
          <summary>Посмотреть текст для агента</summary>
          {text}
        </details>
      ) : (
        text
      )}
      <div className="copy-row">
        <Button
          type="button"
          variant={buttonVariant ?? (collapsible ? "primary" : "secondary")}
          busy={state === "copying"}
          onClick={async () => {
            if ((await copy()) !== "failed") return;
            if (preview.current) preview.current.open = true;
            area.current?.focus();
            area.current?.select();
          }}
        >
          {state === "copied" ? <Check /> : <Copy />}{" "}
          {state === "copied" ? successText : buttonLabel}
        </Button>
        {state === "failed" && (
          <span className="field-note" role="status">
            Браузер не дал скопировать — текст выделен.
          </span>
        )}
      </div>
    </div>
  );
}
