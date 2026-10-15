// Полка's PDF page in the viewer's sandbox (single-file-view-pdf.ts): pdf.js
// draws the embedded file page by page, as the reader scrolls to it. Runs in
// an opaque-origin frame without network; served from the viewer as a module.
import * as pdfjsWorker from "./pdf.worker.min.mjs";
import { AnnotationMode, TextLayer, getDocument } from "./pdf.min.mjs";

/**
 * The document's JavaScript and forms never run: no scripting sandbox is
 * loaded (enableScripting: false is pdf.js's viewer option for that; this
 * page has no viewer and no pdf.sandbox module at all), XFA forms are off,
 * annotations are drawn as pictures without form fields, and nothing is
 * evaluated (pdf.js 6 has no eval path; the CSP has no 'unsafe-eval').
 */
export const VIEW_OPTIONS = Object.freeze({
  enableScripting: false,
  enableXfa: false,
  annotationMode: AnnotationMode.ENABLE,
});
/** A page is drawn when it comes this close to the screen. */
const AHEAD = "1200px 0px";
/** The largest canvas drawn, in pixels (mobile browsers refuse larger ones). */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 960;
/** Pages kept drawn; farther ones give their canvas back and are drawn again on return. */
const KEPT_PAGES = 12;

// The parser runs in this thread: pdf.js starts no worker (CSP worker-src 'none').
globalThis.pdfjsWorker = pdfjsWorker;

const main = document.getElementById("polka-pdf");
const status = main.querySelector(".pdf-status");
const say = (text) => {
  status.textContent = text;
  if (!status.isConnected) main.prepend(status);
};

function decode(base64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function open() {
  const block = document.getElementById("polka-pdf-data");
  const data = decode(block.textContent.trim());
  block.remove();
  const document_ = await getDocument({
    data,
    enableXfa: VIEW_OPTIONS.enableXfa,

    // No network: no font, CMap or wasm files are fetched; embedded fonts are used.
    useSystemFonts: true,
    stopAtErrors: false,
    verbosity: 0,
  }).promise;
  const first = await document_.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const pages = [];
  const drawn = new Set();
  // The frame's width, at most a comfortable reading width on a wide screen.
  const width = () => Math.min(MAX_PAGE_WIDTH, Math.max(160, main.clientWidth - 24));
  const scaleFor = (viewport) => Math.min(width() / viewport.width, 2);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = pages[Number(entry.target.dataset.page) - 1];
        if (entry.isIntersecting) draw(page);
      }
    },
    { rootMargin: AHEAD },
  );

  for (let number = 1; number <= document_.numPages; number++) {
    const box = document.createElement("section");
    box.className = "pdf-page";
    box.dataset.page = String(number);
    box.setAttribute("aria-label", `Страница ${number} из ${document_.numPages}`);
    const label = document.createElement("span");
    label.className = "pdf-number";
    label.textContent = `${number} / ${document_.numPages}`;
    box.append(label);
    pages.push({ number, box, size: base, state: "empty", task: null, text: null });
    main.append(box);
  }
  const layout = (page) => {
    const scale = scaleFor(page.size);
    page.box.style.width = `${Math.floor(page.size.width * scale)}px`;
    page.box.style.height = `${Math.floor(page.size.height * scale)}px`;
  };
  pages.forEach(layout);
  status.remove();
  pages.forEach((page) => observer.observe(page.box));

  function release(page) {
    page.task?.cancel();
    page.text?.cancel();
    page.task = page.text = null;
    page.box.querySelector("canvas")?.remove();
    page.box.querySelector(".textLayer")?.remove();
    page.state = "empty";
    drawn.delete(page);
  }

  async function draw(page) {
    if (page.state !== "empty") return;
    page.state = "drawing";
    drawn.add(page);
    // The farthest drawn pages give their memory back.
    if (drawn.size > KEPT_PAGES) {
      const far = [...drawn]
        .filter((other) => other !== page)
        .sort((a, b) => Math.abs(b.number - page.number) - Math.abs(a.number - page.number));
      for (const other of far.slice(0, drawn.size - KEPT_PAGES)) release(other);
    }
    try {
      const pdfPage = page.number === 1 ? first : await document_.getPage(page.number);
      page.size = pdfPage.getViewport({ scale: 1 });
      layout(page);
      const viewport = pdfPage.getViewport({ scale: scaleFor(page.size) });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.setAttribute("aria-hidden", "true");
      page.box.prepend(canvas);
      page.task = pdfPage.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        annotationMode: VIEW_OPTIONS.annotationMode,
      });
      await page.task.promise;
      // The text over the picture: it can be selected, copied and found.
      const layer = document.createElement("div");
      layer.className = "textLayer";
      page.box.style.setProperty("--scale-factor", String(viewport.scale));
      page.box.style.setProperty("--total-scale-factor", String(viewport.scale));
      page.box.append(layer);
      page.text = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport });
      await page.text.render();
      page.state = "drawn";
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      page.state = "failed";
      const note = document.createElement("p");
      note.className = "pdf-status";
      note.textContent = "Эту страницу не удалось нарисовать.";
      page.box.append(note);
    }
  }

  // A turned phone or a resized window: the pages take the new width.
  let lastWidth = width();
  let timer = 0;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (Math.abs(width() - lastWidth) < 16) return;
      lastWidth = width();
      for (const page of pages) {
        release(page);
        layout(page);
        observer.unobserve(page.box);
        observer.observe(page.box);
      }
    }, 200);
  });
}

open().catch((error) => {
  say(
    error?.name === "PasswordException"
      ? "PDF защищён паролем, Полка его не показывает. Владелец может скачать оригинал."
      : "Не удалось открыть PDF. Владелец может скачать оригинал.",
  );
});
