import { Button, Notice } from "./controls.tsx";
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Полка — главная">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      полка<span className="alpha">local</span>
    </a>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <Notice tone="error">{error}</Notice>
  ) : null;
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => returnFocus.current?.focus();
  }, []);
  return (
    <dialog
      className="ui-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <Button
          variant="quiet"
          className="icon"
          aria-label="Закрыть"
          onClick={onClose}
          disabled={busy}
        >
          <X />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
