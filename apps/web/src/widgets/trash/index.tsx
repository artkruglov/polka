import { useState, useRef } from "react";
import { shelfAccess, useTeamShelf } from "../../entities/shelf/model.ts";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import type { Artifact } from "../../../../../packages/contracts/index.ts";
import { date, size } from "../../entities/artifact/format.ts";
import { Button, Notice, EmptyState } from "../../shared/ui/controls.tsx";

export type TrashPanelProps = {
  items: Artifact[];
  nextCursor: string | null;
  loading: boolean;
  error?: string;
  onLoad: (cursor?: string) => void;
  onRestore: (input: {
    artifact: Artifact;
    expectedLifecycleVersion: number;
    expectedRevisionId: string;
  }) => Promise<void>;
  onOpenArtifact: (artifact: Artifact) => void;
};

function restoreError(error: unknown) {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 409)
      return "Работа изменилась. Обновите список корзины и повторите восстановление.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Работу не удалось восстановить. Попробуйте ещё раз.";
}

export function TrashPanel({
  items,
  nextCursor,
  loading,
  error = "",
  onLoad,
  onRestore,
  onOpenArtifact,
}: TrashPanelProps) {
  // On a department shelf only who may change a work restores it.
  const access = shelfAccess(useTeamShelf(), useAccountState().account?.id);
  const restoring = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>(
    {},
  );

  const restore = async (artifact: Artifact) => {
    if (restoring.current) return;
    restoring.current = true;
    setBusyId(artifact.id);
    setRestoreErrors((current) => ({ ...current, [artifact.id]: "" }));
    try {
      await onRestore({
        artifact,
        expectedLifecycleVersion: artifact.lifecycleVersion,
        expectedRevisionId: artifact.revision.id,
      });
    } catch (reason) {
      setRestoreErrors((current) => ({
        ...current,
        [artifact.id]: restoreError(reason),
      }));
    } finally {
      restoring.current = false;
      setBusyId(null);
    }
  };

  return (
    <section className="trash-panel" aria-labelledby="trash-panel-title">
      <div className="trash-panel-heading">
        <div>
          <p className="trash-panel-kicker eyebrow">Архив хранения</p>
          <h2 id="trash-panel-title">Корзина</h2>
          <p className="trash-panel-muted">
            Работы здесь занимают место. Старые ссылки закрыты и не оживут после
            восстановления.
          </p>
        </div>
        <Button type="button" onClick={() => onLoad()} disabled={loading}>
          {loading ? "Обновляем…" : "Обновить"}
        </Button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {loading && items.length === 0 && (
        <p className="trash-panel-state" role="status">
          Загружаем корзину…
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <EmptyState title="Корзина пуста">
          Работы появятся здесь, если вы переместите их в корзину.
        </EmptyState>
      )}

      {items.length > 0 && (
        <div className="trash-panel-list" aria-live="polite">
          {items.map((artifact) => {
            const restoreMessage = restoreErrors[artifact.id];
            const revisionSize =
              artifact.revision.storageKind === "bundle"
                ? artifact.revision.totalSize
                : artifact.revision.size;
            return (
              <article className="trash-panel-item" key={artifact.id}>
                <div className="trash-panel-item-copy">
                  <h3>{artifact.title}</h3>
                  <p>
                    В корзине {date(artifact.trashedAt ?? artifact.updatedAt)} ·
                    версия {artifact.revision.number} · {size(revisionSize)}
                  </p>
                  <p className="trash-panel-muted">
                    Все версии сохранены. Откройте работу для списка версий и
                    скачивания оригиналов.
                  </p>
                  {restoreMessage && (
                    <Notice tone="error">{restoreMessage}</Notice>
                  )}
                </div>
                <div className="trash-panel-actions">
                  <Button
                    type="button"
                    onClick={() => onOpenArtifact(artifact)}
                  >
                    Версии и скачать
                  </Button>
                  {access.changes(artifact.author) && (
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => void restore(artifact)}
                    disabled={busyId !== null}
                  >
                    {busyId === artifact.id
                      ? "Восстанавливаем…"
                      : "Восстановить"}
                  </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {nextCursor && (
        <Button
          className="trash-panel-more"
          type="button"
          onClick={() => onLoad(nextCursor)}
          disabled={loading}
        >
          {loading ? "Загружаем…" : "Показать ещё"}
        </Button>
      )}
    </section>
  );
}
