import {
  MAX_BYTES,
  MIME,
} from "../../../../../packages/contracts/constants.ts";

/** One description of what an upload may be, for every save form. */
export const UPLOAD_ACCEPT =
  "text/html,.html,.htm,text/plain,.txt,image/png,image/jpeg,image/webp";
export const UPLOAD_FORMATS = "HTML, TXT, PNG, JPEG или WebP · до 5 МБ";

// Browsers may report an empty or generic type for downloaded files; use the
// extension as a hint, while the server still checks the real bytes.
function fileMime(file: File) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  if (/\.html?$/i.test(file.name)) return "text/html";
  if (/\.txt$/i.test(file.name)) return "text/plain";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return file.type;
}

/** The bytes to send with the type the server expects. */
export const uploadBlob = (file: File) =>
  new Blob([file], { type: fileMime(file) });

/** Why this content cannot be saved, or null when it can. */
export function uploadProblem(blob: Blob): string | null {
  if (!blob.size) return "Файл пустой.";
  if (!(MIME as readonly string[]).includes(blob.type))
    return "Этот тип файла не поддерживается. Подойдут HTML, TXT, PNG, JPEG или WebP. ZIP и PDF пока не поддерживаются.";
  if (blob.size > MAX_BYTES) return "Файл больше 5 МБ.";
  return null;
}
