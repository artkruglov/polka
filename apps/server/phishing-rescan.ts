// The phishing signals of a stored version, read again under the current
// rules (phishing-signals.ts), for `moderation.ts recheck --fraud`
// (shares.ts, recheckFraudHolds). The same reading as a save: a page, or
// every page and script of a bundle (artifacts.ts).
import { db } from "./db.ts";
import { inspectHtmlBounded } from "./html.ts";
import { readBlob } from "./storage.ts";
import { SignalCollector, scanScript } from "./phishing-signals.ts";

const MAX_BUNDLE_FILES = 500;
/** revisions.phishing_signals holds at most 64 (029_abuse_protection.sql). */
const MAX_SIGNALS = 64;

type Row = {
  id: string;
  mime: string;
  storage_kind: "single" | "bundle";
  object_key: string;
  object_version: string;
};

/** The signals, or null when the version cannot be read (or is not a page). */
export async function rescanPhishingSignals(revision: Row): Promise<string[] | null> {
  const page = async (key: string, version: string) =>
    (await inspectHtmlBounded((await readBlob(key, version)).toString("utf8"))).signals;
  try {
    if (revision.storage_kind !== "bundle")
      return revision.mime === "text/html"
        ? (await page(revision.object_key, revision.object_version)).slice(0, MAX_SIGNALS)
        : null;
    const files = (
      await db.query(
        `SELECT mime,object_key,object_version FROM revision_files
         WHERE revision_id=$1 AND mime IN ('text/html','text/javascript')
         ORDER BY file_index LIMIT $2`,
        [revision.id, MAX_BUNDLE_FILES],
      )
    ).rows;
    const collector = new SignalCollector();
    if (
      revision.mime === "text/html" &&
      !files.some((file) => file.object_key === revision.object_key)
    )
      for (const signal of await page(revision.object_key, revision.object_version))
        collector.add(signal);
    for (const file of files)
      if (file.mime === "text/html")
        for (const signal of await page(file.object_key, file.object_version))
          collector.add(signal);
      else
        scanScript(
          (await readBlob(file.object_key, file.object_version)).toString("utf8"),
          collector,
        );
    return collector.list().slice(0, MAX_SIGNALS);
  } catch {
    return null;
  }
}
