export type DownloadCapture =
  | { ok: true; text: string; filename: string | null; type: string }
  | {
      ok: false;
      reason: "no_menu" | "no_export" | "no_download" | "navigation" | "binary" | "timeout";
    };

/**
 * Runs in the page's own JavaScript world (chrome.scripting, world: "MAIN"),
 * serialised with Function.prototype.toString: it must not reference anything
 * outside its body, and it imports nothing.
 *
 * On a standalone artifact page (claude.ai/artifact/<id>) the only way to the
 * source is the artifact's own title menu → Export → Download. This presses
 * those items (the title button is marked data-polka-menu=<marker> by the
 * isolated-world script) and takes the file the page is about to save:
 *
 * - for that moment URL.createObjectURL, HTMLAnchorElement.prototype.click,
 *   EventTarget.prototype.dispatchEvent and window.open are wrapped, and a
 *   capture-phase click listener stops a[download] clicks;
 * - a blob: (or data:) download is read and never saved;
 * - a download that would navigate to a server URL is stopped too, and the
 *   caller falls back to the frame;
 * - everything is restored and the menu closed with Escape before returning.
 *
 * «Copy as Markdown» is never pressed: it copies rendered text, not source.
 */
export async function captureDownload(
  marker: string,
  timeoutMs: number,
): Promise<DownloadCapture> {
  const trigger = document.querySelector<HTMLElement>(
    `[data-polka-menu="${CSS.escape(marker)}"]`,
  );
  if (!trigger) return { ok: false, reason: "no_menu" };
  trigger.removeAttribute("data-polka-menu");

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const label = (element: Element) =>
    (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const menuItem = (pattern: RegExp, exclude?: Element | null) =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item !== exclude && pattern.test(label(item)),
    ) ?? null;
  async function waitFor<T>(find: () => T | null, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found || Date.now() > deadline) return found;
      await wait(50);
    }
  }
  // Menus in React UI kits open on pointerdown, not on click; send the whole
  // sequence a real mouse press produces.
  const press = (element: Element) => {
    const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
  };
  const key = (target: Element | Document, name: string) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, composed: true }),
    );

  // --- Interception ---------------------------------------------------------
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalDispatch = EventTarget.prototype.dispatchEvent;
  const originalOpen = window.open;
  const blobs = new Map<string, Blob>();
  let outcome: DownloadCapture | null = null;
  let finish: () => void = () => {};
  const settled = new Promise<void>((resolve) => (finish = resolve));

  const take = async (anchor: HTMLAnchorElement) => {
    if (outcome) return;
    const href = anchor.href;
    const filename = anchor.getAttribute("download") || null;
    let blob: Blob | null = blobs.get(href) ?? null;
    try {
      if (!blob && (href.startsWith("blob:") || href.startsWith("data:")))
        blob = await (await fetch(href)).blob();
    } catch {
      blob = null;
    }
    if (!blob) {
      // A server URL: saving it would put a file in Downloads. Stop instead.
      outcome = { ok: false, reason: "navigation" };
    } else {
      const textual =
        /^(text\/|application\/(json|javascript|xml|xhtml))|svg/i.test(blob.type) ||
        /\.(html?|md|markdown|txt|jsx|tsx|js|ts|svg|css|json|mermaid|mmd)$/i.test(filename ?? "");
      outcome = textual
        ? { ok: true, text: await blob.text(), filename, type: blob.type }
        : { ok: false, reason: "binary" };
    }
    finish();
  };
  const isDownload = (target: unknown): target is HTMLAnchorElement =>
    target instanceof HTMLAnchorElement && target.hasAttribute("download");
  const stopClicks = (event: Event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[download]");
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void take(anchor as HTMLAnchorElement);
  };

  URL.createObjectURL = function (object: Blob | MediaSource) {
    const url = originalCreate.call(URL, object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  } as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (isDownload(this)) void take(this);
    else originalClick.call(this);
  };
  EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
    if (event.type === "click" && isDownload(this)) {
      void take(this);
      return false;
    }
    return originalDispatch.call(this, event);
  };
  window.open = function () {
    // A download opened as a new window is not saved either.
    outcome ??= { ok: false, reason: "navigation" };
    finish();
    return null;
  } as typeof window.open;
  document.addEventListener("click", stopClicks, true);

  try {
    press(trigger);
    let exportItem = await waitFor(() => menuItem(/^(export|экспорт)/), 1500);
    if (!exportItem) {
      // Some menus open from the keyboard only.
      (trigger as HTMLElement).focus?.();
      key(trigger, "Enter");
      exportItem = await waitFor(() => menuItem(/^(export|экспорт)/), 1000);
    }
    if (!exportItem) return { ok: false, reason: "no_export" };
    // A submenu trigger opens on hover, click or →.
    exportItem.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    exportItem.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    press(exportItem);
    let download = await waitFor(() => menuItem(/^(download|скачать)/, exportItem), 1000);
    if (!download) {
      (exportItem as HTMLElement).focus?.();
      key(exportItem, "ArrowRight");
      download = await waitFor(() => menuItem(/^(download|скачать)/, exportItem), 1000);
    }
    if (!download) return { ok: false, reason: "no_download" };
    press(download);
    await Promise.race([settled, wait(timeoutMs)]);
    return outcome ?? { ok: false, reason: "timeout" };
  } finally {
    // Give a page that clicks after an await a moment to be caught, then restore.
    await wait(50);
    document.removeEventListener("click", stopClicks, true);
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
    EventTarget.prototype.dispatchEvent = originalDispatch;
    window.open = originalOpen;
    if (document.querySelector('[role="menu"]')) {
      const focused = document.activeElement ?? document.body;
      key(focused, "Escape");
      if (document.querySelector('[role="menu"]')) key(document, "Escape");
    }
  }
}
