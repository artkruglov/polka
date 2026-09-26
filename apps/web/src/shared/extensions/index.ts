// Extensions' parts of the web app (docs/specs/EXTENSIONS.md): the server
// names them in /api/capabilities, the app imports /ext/<name>.js once, and
// each module adds its sections through window.__polkaHost. The host lends
// the app's own React and controls, so an extension never brings a second
// React and looks like the rest of Полка.
import React, { useSyncExternalStore } from "react";
import type { ExtensionHost, ExtensionSlot } from "../../../../../packages/contracts/extensions.ts";
import { request } from "../api/client.ts";
import { Badge, Button, Notice, SelectField, TextField } from "../ui/controls.tsx";
import { ErrorNotice } from "../ui/index.tsx";

/** A vertical stack with the app's spacing. */
function Stack({ children, as = "div", ...props }: { children?: React.ReactNode; as?: "div" | "form" } & Record<string, unknown>) {
  return React.createElement(as, { ...props, className: "ext-stack" }, children);
}

/** A checkbox with its label, in the app's style. */
function Checkbox({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "label",
    { className: "ext-check" },
    React.createElement("input", {
      type: "checkbox",
      checked,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
    }),
    React.createElement("span", null, children),
  );
}

/** Small print under a section. */
const Fine = ({ children }: { children?: React.ReactNode }) =>
  React.createElement("small", { className: "ext-fine" }, children);

export type ExtensionSection = { id: string; title: string; Component: React.ComponentType<any> };

const sections = new Map<ExtensionSlot, ExtensionSection[]>();
const listeners = new Set<() => void>();
const snapshot = new Map<ExtensionSlot, ExtensionSection[]>();

const host: ExtensionHost = {
  React,
  ui: { Badge, Button, Checkbox, ErrorNotice, Fine, Notice, SelectField, Stack, TextField },
  request: (path, body, method) => request(path, body, method),
  addSection(slot, section) {
    const list = sections.get(slot) ?? [];
    if (list.some((item) => item.id === section.id)) return;
    const next = [...list, section as ExtensionSection];
    sections.set(slot, next);
    snapshot.set(slot, next);
    for (const listener of listeners) listener();
  },
};

let loading: Promise<void> | null = null;

/** Imports the extensions' web modules once per page. */
export function loadExtensions(names: string[]) {
  if (loading || !names.length) return loading ?? Promise.resolve();
  (window as unknown as { __polkaHost: ExtensionHost }).__polkaHost = host;
  // A module script from this origin (CSP script-src 'self'), not import():
  // the app's bundler must not try to resolve it.
  loading = Promise.all(
    names
      .filter((name) => /^[a-z][a-z0-9-]{1,30}$/.test(name))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const script = document.createElement("script");
            script.type = "module";
            script.src = `/ext/${name}.js`;
            script.onload = () => resolve();
            script.onerror = () => {
              console.error("extension web module failed", name);
              resolve();
            };
            document.head.append(script);
          }),
      ),
  ).then(() => undefined);
  return loading;
}

const EMPTY: ExtensionSection[] = [];

/** The sections extensions added to a slot; re-renders when one arrives. */
export const useSlot = (slot: ExtensionSlot) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot.get(slot) ?? EMPTY,
    () => EMPTY,
  );
