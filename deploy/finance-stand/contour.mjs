// Where the contour stand's code is: next to this folder in the VM
// (/opt/contour/finance), or deploy/contour-stand in the repository.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTOUR = existsSync(join(HERE, "..", "dispatcher.mjs"))
  ? join(HERE, "..")
  : join(HERE, "..", "contour-stand");
export const contour = (name) => import(pathToFileURL(join(CONTOUR, name)).href);
