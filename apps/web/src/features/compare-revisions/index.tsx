import "./styles.css";
import React, { useEffect, useRef, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { Revision } from "../../../../../packages/contracts/index.ts";
import { bytes } from "../../shared/api/client.ts";
import { diffInWorker } from "../../shared/lib/line-diff-client.ts";
import type { DiffResult } from "../../shared/lib/line-diff.ts";
import { Button, SelectField } from "../../shared/ui/controls.tsx";
import { date } from "../../entities/artifact/format.ts";
import { DiffView, type BundleFileChanges } from "./DiffView.tsx";
import { fileChanges, readSource, unavailableReason } from "./source.ts";

type State =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  | {
      status: "done";
      from: Revision;
      to: Revision;
      result: DiffResult;
      files: BundleFileChanges | null;
    };

const download = (revision: Revision, signal: AbortSignal) =>
  bytes(
    revision.storageKind === "bundle"
      ? `/revisions/${revision.id}/export`
      : `/revisions/${revision.id}/bytes`,
    undefined,
    signal,
  );

/**
 * The owner picks two versions and sees what changed in the page source.
 * Reads the same owner-only download routes as «Скачать оригинал»; the diff
 * runs in a worker, so a large page does not block the tab.
 */
export function CompareRevisions({
  revisions,
  shown,
}: {
  /** Newest first, as the revisions route returns them. */
  revisions: Revision[];
  /** The version on screen: compared with the one before it by default. */
  shown: Revision;
}) {
  const pick = (id: string) => revisions.find((r) => r.id === id);
  const defaults = () => {
    const at = Math.max(0, revisions.findIndex((r) => r.id === shown.id));
    const older = revisions[at + 1] ?? revisions[at];
    const newer = revisions[at + 1] ? revisions[at] : revisions[at - 1] ?? revisions[at];
    return { from: older?.id ?? "", to: newer?.id ?? "" };
  };
  const [fromId, setFromId] = useState(() => defaults().from);
  const [toId, setToId] = useState(() => defaults().to);
  const [state, setState] = useState<State>({ status: "idle" });
  const abort = useRef<AbortController | null>(null);

  // A new version on screen or a new list resets the pair and the result.
  const key = `${shown.id}:${revisions.map((r) => r.id).join(",")}`;
  useEffect(() => {
    const next = defaults();
    setFromId(next.from);
    setToId(next.to);
    setState({ status: "idle" });
    return () => abort.current?.abort();
  }, [key]);

  if (revisions.length < 2)
    return (
      <p className="revision-compare-empty">
        Сравнивать пока не с чем: у работы одна версия.
      </p>
    );

  const run = async () => {
    const from = pick(fromId),
      to = pick(toId);
    if (!from || !to) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const early = unavailableReason(from) ?? unavailableReason(to);
    if (early) return setState({ status: "unavailable", message: early });
    setState({ status: "busy" });
    try {
      const [before, after] = await Promise.all(
        [from, to].map(async (r) => readSource(r, await download(r, controller.signal))),
      );
      if ("unavailable" in before || "unavailable" in after)
        return setState({
          status: "unavailable",
          message:
            "unavailable" in before
              ? before.unavailable
              : (after as { unavailable: string }).unavailable,
        });
      const result = await diffInWorker(before.text, after.text, controller.signal);
      if (controller.signal.aborted) return;
      setState({
        status: "done",
        from,
        to,
        result,
        files:
          before.files && after.files ? fileChanges(before.files, after.files) : null,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Не удалось сравнить версии.",
      });
    }
  };

  const option = (r: Revision) => (
    <option key={r.id} value={r.id}>
      Версия {r.number} · {date(r.createdAt)}
    </option>
  );
  return (
    <section className="revision-compare" aria-label="Сравнение версий">
      <div className="revision-compare-bar">
        <SelectField
          label="Было"
          value={fromId}
          onChange={(event) => setFromId(event.target.value)}
        >
          {revisions.map(option)}
        </SelectField>
        <SelectField
          label="Стало"
          value={toId}
          onChange={(event) => setToId(event.target.value)}
        >
          {revisions.map(option)}
        </SelectField>
        <Button
          variant="secondary"
          onClick={run}
          busy={state.status === "busy"}
          disabled={fromId === toId}
        >
          <GitCompareArrows />
          {state.status === "busy" ? "Сравниваем…" : "Сравнить"}
        </Button>
      </div>
      {fromId === toId && (
        <p className="revision-compare-hint">Выберите две разные версии.</p>
      )}
      {(state.status === "unavailable" || state.status === "error") && (
        <p
          className={`revision-compare-hint${state.status === "error" ? " revision-compare-hint--error" : ""}`}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      )}
      {state.status === "done" && (
        <DiffView
          from={state.from.number}
          to={state.to.number}
          result={state.result}
          files={state.files}
          entry={
            state.to.storageKind === "bundle"
              ? (state.to.manifest?.entrypoint ?? undefined)
              : undefined
          }
        />
      )}
    </section>
  );
}
