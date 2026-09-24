/*
 * Service worker. Receives requests from three kinds of senders and trusts
 * each only for its own requests:
 *   - the extension's own pages (popup, options): everything;
 *   - the page button on claude.ai / chatgpt.com: save this tab, connect;
 *   - the bridge on the user's Полка: status, import one artifact link.
 * Nothing is sent anywhere except to the configured Полка; there is no
 * analytics and no remote code.
 */
import { importableArtifact } from "../../../packages/contracts/extension-bridge.ts";
import { AuthError, connect, disconnect, isConnected } from "./auth.ts";
import { importUrl, saveTab, type SaveResult } from "./save.ts";
import { getSettings, saveSettings, syncContentScripts } from "./settings.ts";

const PROVIDER_ORIGINS = new Set(["https://claude.ai", "https://chatgpt.com"]);

type Reply = (response?: unknown) => void;

const own = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id &&
  !!sender.url?.startsWith(chrome.runtime.getURL(""));

async function status() {
  const settings = await getSettings();
  return {
    ...settings,
    connected: await isConnected(settings.polkaOrigin),
    version: chrome.runtime.getManifest().version,
  };
}

async function doConnect() {
  const { polkaOrigin } = await getSettings();
  try {
    await connect(polkaOrigin);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof AuthError ? error.message : "Не удалось подключиться к Полке.",
    };
  }
}

function handle(message: any, sender: chrome.runtime.MessageSender): Promise<unknown> | null {
  if (!message || typeof message.type !== "string" || sender.id !== chrome.runtime.id)
    return null;

  if (own(sender)) {
    switch (message.type) {
      case "status":
        return status();
      case "connect":
        return doConnect();
      case "disconnect":
        return getSettings().then((settings) => disconnect(settings.polkaOrigin)).then(() => ({ ok: true }));
      case "save-tab":
        return typeof message.tabId === "number" ? saveTab(message.tabId) : null;
      case "settings":
        return saveSettings(message.settings ?? {}).then(status);
    }
    return null;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return null;

  if (sender.origin && PROVIDER_ORIGINS.has(sender.origin)) {
    if (message.type === "save-tab") return saveTab(tabId);
    if (message.type === "connect") return doConnect();
    if (message.type === "status") return status();
    return null;
  }

  return getSettings().then((settings): Promise<unknown> | unknown => {
    if (sender.origin !== settings.polkaOrigin) return null;
    if (message.type === "bridge-status")
      return status().then((current) => ({
        connected: current.connected,
        version: current.version,
      }));
    if (message.type === "bridge-import") {
      const artifact = importableArtifact(message.url);
      const requestId = String(message.requestId ?? "");
      if (!artifact)
        return {
          ok: false,
          code: "unsupported_url",
          message: "Эту ссылку расширение не открывает.",
        } satisfies SaveResult;
      return importUrl(artifact.url, (stage) => {
        chrome.tabs
          .sendMessage(tabId, { type: "bridge-progress", requestId, stage }, { frameId: 0 })
          .catch(() => {});
      });
    }
    return null;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse: Reply) => {
  const answer = handle(message, sender);
  if (!answer) return false;
  answer.then(
    (value) => sendResponse(value ?? null),
    () => sendResponse(null),
  );
  return true;
});

async function setup() {
  // Tokens in session storage stay out of reach of content scripts.
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await syncContentScripts();
}
chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());
