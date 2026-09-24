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
 * source is the artifact's own title menu → Export → Download. This opens
 * those items (the title button is marked data-polka-menu=<marker> by the
 * isolated-world script) and takes the file the page is about to save.
 *
 * The menu is Base UI (checked on claude.ai 24.09.2026): synthetic pointer
 * events and Enter do not open it; focus + ArrowDown opens the root menu,
 * focus + ArrowRight the Export submenu. Items carry data-download-submenu
 * and data-download-item; their text (Export/Download, Экспорт/Скачать) is
 * the fallback. Synthetic Escape on the document does not close it; Escape
 * on the focused item, Escape on the trigger, an outside pointerdown and a
 * second press of the trigger are tried in that order.
 *
 * While it runs:
 *
 * - for that moment URL.createObjectURL, HTMLAnchorElement.prototype.click,
 *   EventTarget.prototype.dispatchEvent and window.open are wrapped, and a
 *   capture-phase click listener stops a[download] clicks;
 * - a blob: (or data:) download is read and never saved;
 * - a download that would navigate to a server URL is stopped too, and the
 *   caller falls back to the frame;
 * - everything is restored and the menus closed before returning.
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
  const menuItem = (selector: string, pattern: RegExp, exclude?: Element | null) =>
    document.querySelector<HTMLElement>(`[role="menuitem"]${selector}`) ??
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item !== exclude && pattern.test(label(item)),
    ) ??
    null;
  const exportItem = () => menuItem("[data-download-submenu]", /^(export|экспорт)/);
  const downloadItem = (exclude: Element | null) =>
    menuItem("[data-download-item]", /^(download|скачать)/, exclude);
  const menusOpen = () => document.querySelector('[role="menu"]') !== null;
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
  const KEYS: Record<string, string> = {
    ArrowDown: "ArrowDown",
    ArrowRight: "ArrowRight",
    Enter: "Enter",
    Escape: "Escape",
  };
  const key = (target: Element | Document, name: string) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: name,
        code: KEYS[name] ?? name,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  const hover = (element: Element) => {
    for (const type of ["pointerover", "pointerenter", "pointermove"])
      element.dispatchEvent(
        new PointerEvent(type, { bubbles: type !== "pointerenter", pointerType: "mouse" }),
      );
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  };

  /** Leave no menu open: each way is tried only while a menu is still there. */
  async function closeMenus(opener: HTMLElement) {
    const attempts: (() => void)[] = [
      () => {
        const focused = document.activeElement;
        const item = focused?.closest('[role="menu"]')
          ? focused
          : document.querySelector('[role="menu"] [role="menuitem"]');
        if (item instanceof HTMLElement) {
          item.focus();
          key(item, "Escape");
        }
      },
      () => {
        opener.focus();
        key(opener, "Escape");
      },
      () => {
        const init = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
        document.body.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
        document.body.dispatchEvent(new MouseEvent("mousedown", init));
        document.body.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, pointerType: "mouse" }));
        document.body.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      },
      () => press(opener),
    ];
    for (const attempt of attempts) {
      if (!menusOpen()) return;
      attempt();
      await waitFor(() => (menusOpen() ? null : true), 400);
    }
  }

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
    // Root menu: focus + ArrowDown; a mouse press and Enter as fallbacks.
    trigger.focus();
    key(trigger, "ArrowDown");
    let exp = await waitFor(exportItem, 1200);
    if (!exp) {
      press(trigger);
      exp = await waitFor(exportItem, 800);
    }
    if (!exp) {
      trigger.focus();
      key(trigger, "Enter");
      exp = await waitFor(exportItem, 800);
    }
    if (!exp) return { ok: false, reason: "no_export" };
    // Submenu: focus + ArrowRight; Enter and hover open it too, more slowly.
    exp.focus();
    key(exp, "ArrowRight");
    let download = await waitFor(() => downloadItem(exp), 2000);
    if (!download) {
      exp.focus();
      key(exp, "Enter");
      hover(exp);
      download = await waitFor(() => downloadItem(exp), 2000);
    }
    if (!download) return { ok: false, reason: "no_download" };
    press(download);
    await Promise.race([settled, wait(1000)]);
    if (!outcome) {
      // An item that reacts to the keyboard only.
      download.focus();
      key(download, "Enter");
    }
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
    await closeMenus(trigger);
  }
}
