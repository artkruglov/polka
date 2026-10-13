import { Button, Notice } from "./controls.tsx";
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
export function ErrorNotice({ error }: { error: string }) {
  return error ? <Notice tone="error">{error}</Notice> : null;
}
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
/** Open dialogs, newest last: only the top one keeps Tab inside it. */
const openDialogs: HTMLDialogElement[] = [];
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  variant = "center",
  eyebrow,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  /** `panel` docks to the right edge on desktop; every variant is a sheet on phones. */
  variant?: "center" | "panel" | "wide";
  /** Small tracked label above the title (e.g. «Для вашего агента»). */
  eyebrow?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    ref.current?.showModal();
    // A modal <dialog> makes the page inert, but Tab still leaves it for the
    // browser's own controls, and from <body> once the focused control is
    // disabled or removed. Keep Tab cycling inside the dialog.
    const trap = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (event.key !== "Tab" || !dialog?.open || openDialogs.at(-1) !== dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.closest("[inert]") && element.getClientRects().length > 0,
      );
      if (!focusable.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1],
        active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active) && active !== dialog;
      if (!inside || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const self = ref.current;
    if (self) openDialogs.push(self);
    document.addEventListener("keydown", trap, true);
    return () => {
      if (self) openDialogs.splice(openDialogs.indexOf(self), 1);
      document.removeEventListener("keydown", trap, true);
      returnFocus.current?.focus();
    };
  }, []);
  return (
    <dialog
      className={`ui-dialog${variant !== "center" ? ` ui-dialog--${variant}` : ""} ${className}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <div className="dialog-title">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        <Button variant="quiet" className="icon" aria-label="Закрыть" onClick={onClose} disabled={busy}>
          <X />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
