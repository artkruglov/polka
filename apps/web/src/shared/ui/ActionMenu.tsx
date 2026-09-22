import React, {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "./controls.tsx";
export type MenuAction = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  tone?: "danger";
  onSelect: () => void;
};
/** A menu for actions, not global navigation. Dialogs restore focus to its trigger. */
export function ActionMenu({
  label = "Ещё",
  items,
  icon,
  placement = "end",
  direction = "down",
  className = "",
}: {
  label?: string;
  items: MenuAction[];
  /** Icon-only trigger; `label` becomes its accessible name. */
  icon?: React.ReactNode;
  placement?: "start" | "end";
  direction?: "down" | "up";
  className?: string;
}) {
  const [open, setOpen] = useState(false),
    id = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLSpanElement>(null),
    last = useRef(false);
  const buttons = () =>
    Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        "[role=menuitem]:not(:disabled)",
      ) ?? [],
    );
  useLayoutEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLElement>("[role=menu]");
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const shift = Math.max(
      8 - rect.left,
      Math.min(0, window.innerWidth - 8 - rect.right),
    );
    menu.style.transform = `translateX(${shift}px)`;
  }, [open]);
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.querySelector("button")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const options = buttons();
    (last.current ? options.at(-1) : options[0])?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className={`ui-action-menu${placement === "start" ? " ui-action-menu--start" : ""}${direction === "up" ? " ui-action-menu--up" : ""} ${className}`}
      ref={root}
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget) ||
          (e.target.getAttribute("role") === "menuitem" &&
            trigger.current?.contains(e.relatedTarget))
        )
          setOpen(false);
      }}
    >
      <span ref={trigger}>
        <Button
          variant={icon ? "quiet" : "secondary"}
          className={icon ? "icon ui-action-menu-trigger" : ""}
          aria-label={icon ? label : undefined}
          title={icon ? label : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            last.current = false;
            setOpen(!open);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              last.current = e.key === "ArrowUp";
              setOpen(true);
            }
          }}
        >
          {icon ?? label}
        </Button>
      </span>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className="ui-action-menu-items"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
              return;
            }
            const options = buttons(),
              index = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
            let next: number | undefined;
            if (e.key === "ArrowDown") next = (index + 1) % options.length;
            if (e.key === "ArrowUp")
              next = (index - 1 + options.length) % options.length;
            if (e.key === "Home") next = 0;
            if (e.key === "End") next = options.length - 1;
            if (next !== undefined) {
              e.preventDefault();
              options[next]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.tone === "danger" ? "danger" : undefined}
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
