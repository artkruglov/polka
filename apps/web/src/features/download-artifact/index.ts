import type { Revision } from "../../../../../packages/contracts/index.ts";
import { bytes } from "../../shared/api/client.ts";
/** Download the selected immutable revision, not necessarily the latest one. */
export async function downloadRevision(revision: Revision) {
  const blob = await bytes(
    revision.storageKind === "bundle"
      ? `/revisions/${revision.id}/export`
      : `/revisions/${revision.id}/bytes`,
  );
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download =
      revision.storageKind === "bundle"
        ? `${revision.filename.replace(/\.[^.]+$/, "")}.polka.json`
        : revision.filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
