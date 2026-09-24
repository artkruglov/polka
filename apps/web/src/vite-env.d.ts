/// <reference types="vite/client" />

/** The «На Полку» bookmarklet (apps/web/vite.config.ts, extensions/bookmarklet). */
declare module "virtual:polka-bookmarklet" {
  /** javascript: address whose Полка origin is `placeholder`. */
  export const href: string;
  export const placeholder: string;
}
