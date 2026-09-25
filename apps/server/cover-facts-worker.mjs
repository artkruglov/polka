// Worker threads do not inherit the parent's tsx loader, so the entry is plain
// JavaScript that registers it before importing the TypeScript reader.
import { register } from "tsx/esm/api";

register();
await import("./cover-facts-worker.ts");
