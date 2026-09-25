import React, { useId, useRef } from "react";

type TabItem<T extends string> = { id: T; label: React.ReactNode };

/** The tab of `value` in a list rendered with `idBase`: for the panel's aria-labelledby. */
export const tabId = (idBase: string, value: string) => `${idBase}-${value}`;

/**
 * The tablist alone, for a panel rendered elsewhere (a page bar above the
 * content). Arrow keys, Home and End activate; Tab enters the panel.
 */
export function TabList<T extends string>({
  label,
  items,
  value,
  onChange,
  idBase,
  panelId,
  className = "",
}: {
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Prefix of the tabs' ids (see `tabId`). */
  idBase: string;
  panelId: string;
  className?: string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  return (
    <div className={`ui-tabs ${className}`} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={tabId(idBase, item.id)}
          aria-controls={panelId}
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
}

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
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const id = useId();
  const selected = items.findIndex((item) => item.id === value);
  const tablist = (
    <TabList
      label={label}
      items={items}
      value={value}
      onChange={onChange}
      idBase={id}
      panelId={`${id}-panel`}
    />
  );
  return (
    <>
      {trailing ? <div className="ui-tabs-heading">{tablist}<div className="ui-tabs-trailing">{trailing}</div></div> : tablist}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={selected >= 0 ? tabId(id, value) : undefined}
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}
