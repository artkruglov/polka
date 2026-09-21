import React, { useId, useRef } from "react";

/** Controlled horizontal tabs. Arrow keys activate; Tab enters the panel. */
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  children,
  trailing,
}: {
  label: string;
  items: readonly { id: T; label: React.ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const id = useId();
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const selected = items.findIndex((item) => item.id === value);
  const tablist = (
      <div className="ui-tabs" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}`}
            aria-controls={`${id}-panel`}
            aria-selected={item.id === value}
            tabIndex={item.id === value ? 0 : -1}
            ref={(node) => {
              if (node) buttons.current.set(item.id, node);
              else buttons.current.delete(item.id);
            }}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else if (event.key === "ArrowRight")
                next = (index + 1) % items.length;
              else if (event.key === "ArrowLeft")
                next = (index - 1 + items.length) % items.length;
              else return;
              event.preventDefault();
              const target = items[next];
              if (target) {
                onChange(target.id);
                buttons.current.get(target.id)?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
  );
  return (
    <>
      {trailing ? <div className="ui-tabs-heading">{tablist}<div className="ui-tabs-trailing">{trailing}</div></div> : tablist}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={selected >= 0 ? `${id}-${value}` : undefined}
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}
