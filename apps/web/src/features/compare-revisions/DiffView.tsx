import React from "react";
import {
  collapseDiff,
  DIFF_LIMITS,
  type DiffLine,
  type DiffResult,
} from "../../shared/lib/line-diff.ts";

/** Changed lines shown at most; the rest is summarised, not rendered. */
export const MAX_SHOWN_CHANGES = 2000;
/** A minified page can be one very long line; show its start only. */
const MAX_LINE_CHARS = 2000;

export function lines(count: number) {
  const n = Math.abs(count) % 100,
    last = n % 10;
  const word =
    n > 10 && n < 20
      ? "строк"
      : last === 1
        ? "строка"
        : last >= 2 && last <= 4
          ? "строки"
          : "строк";
  return `${count.toLocaleString("ru-RU")} ${word}`;
}

function Row({ line }: { line: DiffLine }) {
  const text =
    line.text.length > MAX_LINE_CHARS
      ? `${line.text.slice(0, MAX_LINE_CHARS)} … ещё ${(line.text.length - MAX_LINE_CHARS).toLocaleString("ru-RU")} символов`
      : line.text;
  return (
    <div className={`revision-diff-row revision-diff-row--${line.kind}`}>
      <span className="revision-diff-number" aria-hidden="true">
        {line.a ?? ""}
      </span>
      <span className="revision-diff-number" aria-hidden="true">
        {line.b ?? ""}
      </span>
      <span className="revision-diff-sign" aria-hidden="true">
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
      </span>
      <code>
        {line.kind !== "same" && (
          <span className="sr-only">
            {line.kind === "add"
              ? `Добавлено, строка ${line.b}: `
              : `Удалено, строка ${line.a}: `}
          </span>
        )}
        {text || " "}
      </code>
    </div>
  );
}

export type BundleFileChanges = {
  added: string[];
  removed: string[];
  changed: string[];
};

/** A readable line diff of two versions' source: what changed, not the whole page. */
export function DiffView({
  from,
  to,
  result,
  files,
  entry,
}: {
  from: number;
  to: number;
  result: DiffResult;
  files?: BundleFileChanges | null;
  /** The compared file of a bundle (its entry point). */
  entry?: string;
}) {
  const { rows, truncated } = collapseDiff(result.lines, {
    maxChanged: MAX_SHOWN_CHANGES,
  });
  const fileNotes = files
    ? [
        files.changed.length && `изменены: ${files.changed.join(", ")}`,
        files.added.length && `добавлены: ${files.added.join(", ")}`,
        files.removed.length && `удалены: ${files.removed.join(", ")}`,
      ].filter(Boolean)
    : [];
  return (
    <div className="revision-diff-result">
      <p className="revision-diff-summary" role="status">
        Версия {from} → версия {to}
        {entry ? ` · ${entry}` : ""}:{" "}
        {result.added || result.removed ? (
          <>
            <span className="revision-diff-count--add">+{lines(result.added)}</span>
            {" · "}
            <span className="revision-diff-count--del">−{lines(result.removed)}</span>
          </>
        ) : (
          "исходный код не изменился."
        )}
      </p>
      {(fileNotes.length > 0 || !result.exact || result.clipped || truncated) && (
        <ul className="revision-diff-notes">
          {fileNotes.length > 0 && <li>Файлы пакета: {fileNotes.join("; ")}.</li>}
          {result.clipped && (
            <li>
              Сравнены первые {lines(DIFF_LIMITS.maxLines)} каждой версии; дальше
              файл не сравнивался.
            </li>
          )}
          {!result.exact && (
            <li>
              Версии слишком различаются для точного построчного сравнения:
              изменённый участок показан как замена целиком.
            </li>
          )}
          {truncated && (
            <li>
              Показаны первые {lines(MAX_SHOWN_CHANGES)} изменений — показано не
              всё. Чтобы сравнить полностью, скачайте обе версии.
            </li>
          )}
        </ul>
      )}
      {rows.length > 0 && (
        <div
          className="revision-diff"
          role="region"
          aria-label={`Изменения исходного кода, версия ${from} → версия ${to}`}
          tabIndex={0}
        >
          {rows.map((row, index) =>
            row.kind === "skip" ? (
              <div className="revision-diff-skip" key={index}>
                {lines(row.count)} без изменений
              </div>
            ) : (
              <Row line={row.line} key={index} />
            ),
          )}
          {truncated && (
            <div className="revision-diff-skip">Дальше — показано не всё.</div>
          )}
        </div>
      )}
    </div>
  );
}
