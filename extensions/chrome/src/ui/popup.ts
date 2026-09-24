/* The toolbar popup: connect, save the artifact in this tab, show the link. */
import { el, renderResult, type Result } from "./render.ts";

type Status = {
  polkaOrigin: string;
  connected: boolean;
  version: string;
};

const main = document.getElementById("main")!;
const originLabel = document.getElementById("origin")!;
document.getElementById("options")!.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

const PROVIDERS = new Set(["claude.ai", "chatgpt.com"]);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    host = new URL(tab?.url ?? "").hostname;
  } catch {
    /* no URL: not a page this extension may read */
  }
  return { id: tab?.id, onProvider: PROVIDERS.has(host) };
}

async function render() {
  const status = await chrome.runtime.sendMessage<Status>({ type: "status" });
  originLabel.textContent = new URL(status.polkaOrigin).host;
  if (!status.connected) {
    const connect = el("button", { type: "button", className: "primary", textContent: "Подключить Полку" });
    const error = el("p", { className: "error", hidden: true });
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      connect.textContent = "Ждём разрешения…";
      const answer = await chrome.runtime.sendMessage<{ ok: boolean; message?: string }>({ type: "connect" });
      if (answer?.ok) return void render();
      connect.disabled = false;
      connect.textContent = "Подключить Полку";
      error.textContent = answer?.message ?? "Не подключено.";
      error.hidden = false;
    });
    main.replaceChildren(
      el("p", {}, "Подключите расширение к своей Полке: откроется окно входа, где вы разрешите сохранять работы и выдавать ссылки."),
      connect,
      error,
    );
    return;
  }
  const tab = await activeTab();
  if (!tab.onProvider || tab.id === undefined) {
    main.replaceChildren(
      el("p", {}, "Откройте артефакт в Claude или ChatGPT и нажмите «Сохранить на Полку» здесь или кнопку «На Полку» рядом с артефактом."),
      el("p", { className: "muted" }, "Ссылку на артефакт можно и вставить в поле «Сохранить» на Полке — расширение заберёт его само."),
    );
    return;
  }
  const save = el("button", { type: "button", className: "primary", textContent: "Сохранить на Полку" });
  const out = el("div", { className: "result" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Сохраняем…";
    const result = await chrome.runtime
      .sendMessage<Result>({ type: "save-tab", tabId: tab.id })
      .catch(() => null);
    save.disabled = false;
    save.textContent = "Сохранить на Полку";
    out.replaceChildren(...renderResult(result, () => void render()));
  });
  main.replaceChildren(
    el("p", {}, "Сохранит открытый артефакт на вашу полку и выдаст ссылку."),
    save,
    out,
  );
}

void render();
