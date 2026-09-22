import { useRef, useState } from "react";
import type {
  Artifact,
  Receipt,
  UploadInput,
} from "../../../../../packages/contracts/index.ts";
import {
  client,
  saveUpload,
  type PendingUpload,
} from "../../shared/api/client.ts";

export type SavedUpload = { receipt: Receipt; work: Artifact | null };

/**
 * The save flow shared by file and pasted-code capture: upload once, then read
 * the saved work. A failed read never hides the receipt and never re-sends the
 * finalized upload — `showSaved` retries only the read.
 */
export function useSaveUpload() {
  const operation = useRef<PendingUpload | null>(null);
  const [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState<SavedUpload | null>(null);

  const showSaved = async (receipt: Receipt) => {
    setError("");
    setStage("Открываем сохранённую работу…");
    try {
      setSaved({ receipt, work: await client.artifact(receipt.artifactId) });
    } catch (e) {
      setSaved({ receipt, work: null });
      setError(
        `Работа сохранена, но показать её не удалось. ${(e as Error).message}`,
      );
    } finally {
      setStage("");
    }
  };

  const save = async (
    file: Blob,
    input: Omit<UploadInput, "key" | "mime" | "size" | "sha256">,
  ) => {
    setError("");
    operation.current ??= { file, key: crypto.randomUUID() };
    let receipt: Receipt;
    try {
      receipt = await saveUpload(operation.current, input, setStage);
    } catch (e) {
      setError((e as Error).message);
      setStage("");
      return;
    }
    operation.current = null;
    await showSaved(receipt);
  };

  /** The content or destination changed: the next save is a new upload. */
  const invalidate = () => {
    operation.current = null;
    setError("");
  };

  const reset = () => {
    invalidate();
    setSaved(null);
  };

  return {
    stage,
    busy: !!stage,
    error,
    setError,
    saved,
    /** A failed attempt that «Повторить сохранение» would resume with the same key. */
    retrying: !!error && !!operation.current,
    save,
    showSaved,
    invalidate,
    reset,
  };
}
