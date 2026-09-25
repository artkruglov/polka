import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * A small non-modal panel under an icon button (details, not actions).
 * Escape and a click outside close it; closing with Escape returns focus to the trigger.
 */
export function Popover({
  label,
  icon,
  children,
  className = "",
}: {
  /** The trigger's accessible name and tooltip; also names the panel. */
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false),
    id = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  // Keep the panel inside the viewport on narrow screens.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = root.current?.querySelector<HTMLElement>(".ui-popover-panel");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const shift = Math.max(
      8 - rect.left,
      Math.min(0, window.innerWidth - 8 - rect.right),
    );
    panel.style.transform = `translateX(${shift}px)`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className={`ui-popover ${className}`}
      ref={root}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="ui-icon-button ui-icon-button--sm ui-popover-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {/* Rendered while closed too: the details stay in the page's text. */}
      <div
        id={id}
        role="group"
        aria-label={label}
        className="ui-popover-panel"
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
