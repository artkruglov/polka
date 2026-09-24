/*
 * The bookmark's only UI: a small card in the page's top right corner, in a
 * closed shadow root so the page's styles do not reach it. Styles are set
 * through element.style (CSSOM), which a page's CSP does not block, unlike a
 * <style> element; text goes through textContent only (no innerHTML: pages
 * with Trusted Types would refuse it).
 */

type Style = Partial<Record<keyof CSSStyleDeclaration, string>>;

const HOST_ID = "polka-bookmarklet-toast";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Style,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

export type Toast = {
  progress(text: string): void;
  done(text: string): void;
  error(text: string): void;
  /** A message with one button; the click is a fresh user activation. */
  action(text: string, label: string, onClick: () => void): void;
  close(): void;
};

export function toast(): Toast {
  document.getElementById(HOST_ID)?.remove();
  // The page's styles for div do not reach the host either: reset first.
  const host = element("div", { all: "initial" });
  Object.assign(host.style, { position: "fixed", top: "16px", right: "16px", zIndex: "2147483647" });
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  const card = element("div", {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    width: "min(340px, calc(100vw - 32px))",
    padding: "12px 14px",
    borderRadius: "12px",
    background: "#ffffff",
    color: "#1b1f24",
    border: "1px solid #d8dee9",
    boxShadow: "0 8px 28px rgba(15, 23, 42, .18)",
    font: "500 14px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  });
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  const mark = element("span", {
    flex: "0 0 auto",
    width: "22px",
    height: "22px",
    borderRadius: "6px",
    background: "#2f5bd3",
    color: "#fff",
    font: "700 13px/22px system-ui, sans-serif",
    textAlign: "center",
  }, "П");
  const body = element("div", { flex: "1 1 auto", minWidth: "0" });
  const title = element("div", { fontWeight: "600" }, "На Полку");
  const text = element("div", { marginTop: "2px", color: "#3d4450", overflowWrap: "anywhere" });
  const actions = element("div", { marginTop: "8px", display: "none" });
  const button = element("button", {
    cursor: "pointer",
    border: "0",
    borderRadius: "8px",
    padding: "7px 12px",
    background: "#2f5bd3",
    color: "#fff",
    font: "600 13px/1.2 system-ui, sans-serif",
  });
  button.type = "button";
  actions.append(button);
  body.append(title, text, actions);
  const close = element("button", {
    flex: "0 0 auto",
    cursor: "pointer",
    border: "0",
    background: "transparent",
    color: "#6b7280",
    font: "400 18px/1 system-ui, sans-serif",
    padding: "0 2px",
  }, "×");
  close.type = "button";
  close.setAttribute("aria-label", "Закрыть");
  card.append(mark, body, close);
  root.append(card);
  (document.body ?? document.documentElement).append(host);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAction: (() => void) | null = null;
  const remove = () => {
    clearTimeout(timer);
    host.remove();
  };
  close.addEventListener("click", remove);
  button.addEventListener("click", () => {
    const run = onAction;
    onAction = null;
    actions.style.display = "none";
    run?.();
  });
  const show = (value: string, colour: string, hideAfter?: number) => {
    clearTimeout(timer);
    onAction = null;
    actions.style.display = "none";
    text.textContent = value;
    mark.style.background = colour;
    if (hideAfter) timer = setTimeout(remove, hideAfter);
  };
  return {
    progress: (value) => show(value, "#2f5bd3"),
    done: (value) => show(value, "#1f8a4c", 6000),
    error: (value) => {
      show(value, "#c2410c");
      card.setAttribute("role", "alert");
    },
    action: (value, label, run) => {
      show(value, "#2f5bd3");
      button.textContent = label;
      onAction = run;
      actions.style.display = "block";
    },
    close: remove,
  };
}
