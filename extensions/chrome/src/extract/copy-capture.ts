/**
 * Runs in the provider page's own JavaScript world (chrome.scripting,
 * world: "MAIN"), serialised with Function.prototype.toString: it must not
 * reference anything outside its body, and it imports nothing.
 *
 * It presses the artifact's own «Copy» button, which the isolated-world
 * script has marked with data-polka-copy=<marker>, and takes the text the
 * page hands to the clipboard. navigator.clipboard.writeText/write are
 * replaced for that moment only, so the text never reaches the user's
 * clipboard and the extension needs no clipboard permission. Everything is
 * restored before returning.
 */
export async function captureCopy(
  marker: string,
  timeoutMs: number,
): Promise<string | null> {
  const button = document.querySelector<HTMLElement>(
    `[data-polka-copy="${CSS.escape(marker)}"]`,
  );
  if (!button) return null;
  button.removeAttribute("data-polka-copy");
  const clipboard = navigator.clipboard as
    | (Clipboard & Record<string, unknown>)
    | undefined;
  const ownWriteText =
    !!clipboard && Object.prototype.hasOwnProperty.call(clipboard, "writeText");
  const ownWrite =
    !!clipboard && Object.prototype.hasOwnProperty.call(clipboard, "write");
  const previousWriteText = clipboard?.writeText;
  const previousWrite = clipboard?.write;
  let captured: string | null = null;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const onCopy = (event: ClipboardEvent) => {
    const text =
      event.clipboardData?.getData("text/plain") ||
      document.getSelection()?.toString() ||
      "";
    if (text) {
      captured = text;
      finish();
    }
  };
  try {
    if (clipboard) {
      clipboard.writeText = async (text: string) => {
        captured = String(text);
        finish();
      };
      clipboard.write = async (items: ClipboardItems) => {
        for (const item of items)
          if (item.types.includes("text/plain")) {
            captured = await (await item.getType("text/plain")).text();
            break;
          }
        finish();
      };
    }
    window.addEventListener("copy", onCopy);
    button.click();
    await Promise.race([
      finished,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return captured;
  } finally {
    window.removeEventListener("copy", onCopy);
    if (clipboard) {
      if (ownWriteText) clipboard.writeText = previousWriteText!;
      else delete (clipboard as Record<string, unknown>).writeText;
      if (ownWrite) clipboard.write = previousWrite!;
      else delete (clipboard as Record<string, unknown>).write;
    }
  }
}
