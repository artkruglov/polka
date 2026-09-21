// Worker threads do not inherit the parent's tsx loader, so the entry is plain
// JavaScript that registers it before importing the TypeScript builder.
import { register } from "tsx/esm/api";

register();
await import("./bundle-build-worker.ts");
