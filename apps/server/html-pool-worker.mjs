// Worker threads do not inherit the parent's tsx loader, so the entry is plain
// JavaScript that registers it before importing the TypeScript readers.
import { register } from "tsx/esm/api";

register();
await import("./html-pool-worker.ts");
