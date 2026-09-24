import { DEFAULT_POLKA_ORIGIN, matchPattern, normaliseOrigin } from "./shared/origin.ts";

export type Settings = {
  /** The user's Полка: polochka.app, or a self-hosted installation. */
  polkaOrigin: string;
  /** Show the «На Полку» button on Claude and ChatGPT pages. */
  pageButton: boolean;
};

const DEFAULTS: Settings = { polkaOrigin: DEFAULT_POLKA_ORIGIN, pageButton: true };

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const stored = (settings ?? {}) as Partial<Settings>;
  return {
    polkaOrigin: normaliseOrigin(stored.polkaOrigin ?? "") ?? DEFAULTS.polkaOrigin,
    pageButton: stored.pageButton ?? DEFAULTS.pageButton,
  };
}

export async function saveSettings(next: Partial<Settings>) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...next } });
  await syncContentScripts();
}

const PROVIDER_PAGES = ["https://claude.ai/*", "https://chatgpt.com/*"];

/**
 * Content scripts are registered from code, not the manifest, so they follow
 * the settings: the page button only while it is switched on, the bridge only
 * on the configured Полка (and only once its host permission is granted).
 */
export async function syncContentScripts() {
  const settings = await getSettings();
  const wanted: chrome.scripting.RegisteredContentScript[] = [];
  if (settings.pageButton)
    wanted.push({
      id: "page-button",
      matches: PROVIDER_PAGES,
      js: ["page-button.js"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    });
  const bridgeMatch = matchPattern(settings.polkaOrigin);
  if (await chrome.permissions.contains({ origins: [bridgeMatch] }))
    wanted.push({
      id: "polka-bridge",
      matches: [bridgeMatch],
      js: ["bridge.js"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    });
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length)
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((script) => script.id),
    });
  if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
}
