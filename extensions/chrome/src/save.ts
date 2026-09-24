/*
 * Extract an artifact from a tab and save it to the user's Полка. Runs in the
 * service worker; the page is read only here, on the user's request (toolbar,
 * the page button, or Полка's «Сохранить» handing over a link).
 */
import type {
  ImportFailure,
  ImportStage,
  ImportSuccess,
} from "../../../packages/contracts/extension-bridge.ts";
import { AuthError, connect, isConnected } from "./auth.ts";
import { noteFor, publish, PublishError } from "./api.ts";
import { captureCopy } from "./extract/copy-capture.ts";
import type { FrameReport } from "./extract/frame.ts";
import type { PageReport } from "./extract/page.ts";
import { getSettings } from "./settings.ts";
import { pickBest, publishBody, type Extracted } from "./shared/payload.ts";

export type SaveResult = ImportSuccess | ImportFailure;

const fail = (code: ImportFailure["code"], message: string): ImportFailure => ({
  ok: false,
  code,
  message,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One pass over the tab: the page, its Copy button, the artifact frames. */
async function extractOnce(tabId: number): Promise<{
  best: Extracted | null;
  page: PageReport | null;
}> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["extract-page.js"],
  });
  const [inspected] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => (globalThis as any).__polkaPage.inspect() as PageReport,
  });
  const page = inspected?.result ?? null;
  if (!page?.provider) return { best: null, page };
  const candidates: (Extracted | null)[] = [];
  const base = { provider: page.provider, title: page.title };

  if (page.copyMarker) {
    const [copied] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: captureCopy,
      args: [page.copyMarker, 2500],
    });
    if (typeof copied?.result === "string")
      candidates.push({ ...base, source: copied.result, language: page.code?.language ?? null, via: "copy-button" });
  }
  if (page.code)
    candidates.push({ ...base, source: page.code.source, language: page.code.language, via: "code-view" });

  if (page.provider === "claude" && page.frames > 0) {
    // Frames on hosts without permission are skipped by Chrome.
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ["extract-frame.js"] })
      .catch(() => []);
    const frames = await chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        func: () =>
          ((globalThis as any).__polkaFrame?.extract() ?? null) as Promise<FrameReport | null>,
      })
      .catch(() => []);
    for (const frame of frames) {
      const report = frame.result;
      if (!report) continue;
      candidates.push({
        ...base,
        title: page.title || report.title,
        source: report.html,
        language: "html",
        via: report.via,
      });
    }
  }
  return { best: pickBest(candidates), page };
}

/** Retries while the provider's app is still rendering the artifact. */
async function extract(tabId: number, patienceMs: number) {
  const deadline = Date.now() + patienceMs;
  let last: Awaited<ReturnType<typeof extractOnce>> = { best: null, page: null };
  do {
    try {
      last = await extractOnce(tabId);
    } catch {
      /* the tab navigated mid-way; try again */
    }
    if (last.best || last.page?.signIn) return last;
    await wait(1200);
  } while (Date.now() < deadline);
  return last;
}

async function ensureConnected(origin: string, onStage?: (stage: ImportStage) => void) {
  if (await isConnected(origin)) return null;
  onStage?.("connecting");
  try {
    await connect(origin);
    return null;
  } catch (error) {
    return fail(
      "not_connected",
      error instanceof AuthError ? error.message : "Не удалось подключиться к Полке.",
    );
  }
}

async function saveExtracted(origin: string, extracted: Extracted): Promise<SaveResult> {
  const body = publishBody(extracted, crypto.randomUUID());
  try {
    const published = await publish(origin, body);
    return {
      ok: true,
      title: body.title,
      url: published.url,
      shelfUrl: published.shelfUrl,
      note: noteFor(published),
    };
  } catch (error) {
    if (error instanceof PublishError) return fail(error.code, error.message);
    return fail("publish_failed", "Не удалось сохранить на Полку.");
  }
}

const NOTHING_FOUND =
  "Артефакт на странице не найден. Откройте его так, чтобы он был виден справа от чата, и нажмите ещё раз.";
const SIGN_IN = "Войдите в Claude или ChatGPT в этом браузере и повторите.";

/** The toolbar or page button: the artifact open in this tab. */
export async function saveTab(tabId: number): Promise<SaveResult> {
  const { polkaOrigin } = await getSettings();
  const notConnected = await ensureConnected(polkaOrigin);
  if (notConnected) return notConnected;
  const { best, page } = await extract(tabId, 4000);
  if (page?.signIn) return fail("not_found", SIGN_IN);
  if (!page?.provider)
    return fail("unsupported_url", "Откройте артефакт на claude.ai или chatgpt.com.");
  if (!best) return fail("extract_failed", NOTHING_FOUND);
  return saveExtracted(polkaOrigin, best);
}

let busy = false;

/**
 * Полка's page handed over a link: open it in a background tab of this
 * browser (the user's own session), extract, close, save.
 */
export async function importUrl(
  url: string,
  onStage: (stage: ImportStage) => void,
): Promise<SaveResult> {
  if (busy) return fail("busy", "Расширение уже сохраняет другой артефакт. Дождитесь его.");
  busy = true;
  let tabId: number | undefined;
  try {
    const { polkaOrigin } = await getSettings();
    const notConnected = await ensureConnected(polkaOrigin, onStage);
    if (notConnected) return notConnected;
    onStage("opening");
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id!;
    await loaded(tabId, 30_000);
    onStage("extracting");
    const { best, page } = await extract(tabId, 20_000);
    if (page?.signIn) return fail("not_found", SIGN_IN);
    if (!best) return fail("extract_failed", "Не удалось найти артефакт по ссылке. Откройте ссылку сами и нажмите «На Полку» на странице артефакта.");
    onStage("saving");
    return await saveExtracted(polkaOrigin, best);
  } catch (error) {
    return fail(
      error instanceof Error && error.message === "timeout" ? "timeout" : "extract_failed",
      "Страница артефакта не открылась вовремя. Проверьте ссылку и вход в Claude.",
    );
  } finally {
    busy = false;
    if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
  }
}

function loaded(tabId: number, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id: number) => {
      if (id === tabId) {
        cleanup();
        reject(new Error("closed"));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}
