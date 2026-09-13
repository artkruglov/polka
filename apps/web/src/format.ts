import type { Artifact, Revision } from "../../../packages/contracts/index.ts";
export const date = (s: string) =>
  new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
export const size = (n: number) =>
  n < 1024
    ? `${n} Б`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} КБ`
      : `${(n / 1024 / 1024).toFixed(1)} МБ`;
export const status = (a: Artifact) =>
  a.share && ["active", "behind"].includes(a.share.status)
    ? `По ссылке · v${a.share.number}`
    : "Только вы";
export const isImage = (r: Revision) => r.mime.startsWith("image/");
