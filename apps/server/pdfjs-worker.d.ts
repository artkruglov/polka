// pdf.js's parser module (pdfjs-dist ships no types for it): pdf-reader.ts
// sets it as globalThis.pdfjsWorker so the parser runs in the pool worker.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
