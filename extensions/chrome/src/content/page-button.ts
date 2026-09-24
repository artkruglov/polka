/*
 * The «На Полку» button on claude.ai and chatgpt.com (only while switched on
 * in the extension's settings). It looks for an open artifact to decide where
 * to show itself and reads nothing else; the artifact is read by the service
 * worker only after a click (save.ts).
 *
 * The button sits in its own shadow root next to the artifact's Copy button
 * when that button can be found, and floats in the corner of the artifact
 * otherwise.
 */
import {
  artifactPanel,
  findArtifactFrames,
  findCopyButton,
  findShareButton,
} from "../extract/dom.ts";
import { STYLES } from "./page-button-styles.ts";

type Result =
  | { ok: true; title: string; url: string | null; shelfUrl: string; note: string | null }
  | { ok: false; code: string; message: string }
  | null;

const HOST_TAG = "polka-save-button";

function anchor(): { frame: Element; copy: HTMLElement | null } | null {
  if (location.hostname === "claude.ai") {
    const frame = findArtifactFrames(document)[0];
    if (!frame || frame.getBoundingClientRect().width < 200) return null;
    const panel = artifactPanel(frame);
    // Next to the panel's Copy button in a chat; next to Share on a
    // standalone artifact page (claude.ai/artifact/<id>).
    return {
      frame,
      copy: (panel ? findCopyButton(panel) : null) ?? findShareButton(document),
    };
  }
  // ChatGPT: an open canvas/code panel.
  const panel = document.querySelector(
    '[data-testid*="canvas" i], [data-testid*="textdoc" i], section[aria-label*="canvas" i]',
  );
  return panel ? { frame: panel, copy: findCopyButton(panel) } : null;
}

function create() {
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${STYLES}</style>
<div class="wrap">
  <button type="button" class="save" title="Сохранить артефакт на Полку">На Полку</button>
  <div class="card" role="status" aria-live="polite" hidden></div>
</div>`;
  const button = root.querySelector<HTMLButtonElement>(".save")!;
  const card = root.querySelector<HTMLDivElement>(".card")!;

  const show = (nodes: (Node | string)[]) => {
    card.replaceChildren(...nodes);
    card.hidden = false;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...children: (Node | string)[]
  ) => {
    const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const close = el("button", { type: "button", className: "close", title: "Закрыть", textContent: "×" });
  close.addEventListener("click", () => (card.hidden = true));

  const render = (result: Result) => {
    if (!result) {
      show([close, el("p", {}, "Расширение не ответило. Обновите страницу.")]);
      return;
    }
    if (!result.ok) {
      const nodes: (Node | string)[] = [close, el("p", { className: "error" }, result.message)];
      if (result.code === "not_connected") {
        const connect = el("button", { type: "button", className: "primary", textContent: "Подключить Полку" });
        connect.addEventListener("click", async () => {
          connect.disabled = true;
          const answer = await chrome.runtime.sendMessage<{ ok: boolean; message?: string }>({ type: "connect" });
          if (answer?.ok) void save();
          else show([close, el("p", { className: "error" }, answer?.message ?? "Не подключено.")]);
        });
        nodes.push(connect);
      }
      show(nodes);
      return;
    }
    const nodes: (Node | string)[] = [close, el("strong", {}, `«${result.title}» на полке`)];
    if (result.url) {
      const field = el("input", { readOnly: true, value: result.url, className: "link" });
      field.setAttribute("aria-label", "Ссылка");
      field.addEventListener("focus", () => field.select());
      const copy = el("button", { type: "button", className: "primary", textContent: "Копировать" });
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(result.url!);
          copy.textContent = "Скопировано";
        } catch {
          field.select();
        }
      });
      nodes.push(field, copy);
    }
    if (result.note) nodes.push(el("p", {}, result.note));
    nodes.push(
      el("a", { href: result.shelfUrl, target: "_blank", rel: "noopener", className: "secondary" }, "Открыть на полке"),
    );
    show(nodes);
  };

  const save = async () => {
    button.disabled = true;
    button.textContent = "Сохраняем…";
    card.hidden = true;
    try {
      render(await chrome.runtime.sendMessage<Result>({ type: "save-tab" }));
    } catch {
      render(null);
    } finally {
      button.disabled = false;
      button.textContent = "На Полку";
    }
  };
  button.addEventListener("click", () => void save());
  return host;
}

let host: HTMLElement | null = null;
let scheduled = false;

function place() {
  scheduled = false;
  const found = anchor();
  if (!found) {
    host?.remove();
    return;
  }
  host ??= create();
  if (found.copy?.parentElement) {
    if (host.nextElementSibling !== found.copy) found.copy.parentElement.insertBefore(host, found.copy);
    host.removeAttribute("data-floating");
    host.style.cssText = "display:inline-flex;align-items:center;margin-right:6px;";
    return;
  }
  // No Copy button found: float over the artifact's top-right corner.
  if (host.parentElement !== document.body) document.body.append(host);
  const rect = found.frame.getBoundingClientRect();
  host.setAttribute("data-floating", "");
  host.style.cssText = `position:fixed;z-index:2147483646;top:${Math.max(8, rect.top + 8)}px;right:${Math.max(8, window.innerWidth - rect.right + 8)}px;`;
}

const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(place, 400);
};

new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
window.addEventListener("resize", schedule);
schedule();
