import React, { useEffect, useState } from "react";
import type { Artifact, Revision } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { Button, SelectField } from "../../shared/ui/controls.tsx";
import { Dialog } from "../../shared/ui/index.tsx";

/**
 * A curator marks which version of the work is accepted, who answers for it,
 * and whether an unattended agent may move the work's link to new versions
 * (docs/specs/DATA_MODELS.md §1, §2). None of this moves a link by itself.
 */
export function AcceptRevisionPanel({
  artifact,
  accountId,
  onClose,
  onSaved,
}: {
  artifact: Artifact;
  accountId: string | undefined;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [accepted, setAccepted] = useState(artifact.acceptedRevisionId ?? "");
  const [mine, setMine] = useState(
    !!accountId && artifact.ownerAccountId === accountId,
  );
  const link = artifact.share && ["active", "behind"].includes(artifact.share.status)
    ? artifact.share
    : null;
  const [follows, setFollows] = useState(link?.followMode === "follows");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    client
      .revisions(artifact.id)
      .then((list) => live && setRevisions(list))
      .catch(() => live && setError("Не удалось загрузить версии."));
    return () => {
      live = false;
    };
  }, [artifact.id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if ((artifact.acceptedRevisionId ?? "") !== accepted)
        await client.acceptRevision(artifact.id, accepted || null);
      const wasMine = !!accountId && artifact.ownerAccountId === accountId;
      if (accountId && mine !== wasMine)
        await client.setWorkOwner(artifact.id, mine ? accountId : null);
      if (link && follows !== (link.followMode === "follows"))
        await client.setShareFollow(link.id, follows ? "follows" : "pinned");
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сохранить отметки.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Принятая версия"
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="dialog-body artifact-metadata-form">
          <SelectField
            label="Принятая версия"
            value={accepted}
            onChange={(event) => setAccepted(event.target.value)}
            disabled={!revisions}
          >
            <option value="">Не отмечена</option>
            {(revisions ?? []).map((revision) => (
              <option value={revision.id} key={revision.id}>
                Версия {revision.number}
              </option>
            ))}
          </SelectField>
          <p className="ui-field-hint">
            Отметка видна коллегам и агентам. Ссылки она не меняет: ссылка
            остаётся на своей версии.
          </p>
          {accountId && (
            <label>
              <input
                type="checkbox"
                checked={mine}
                onChange={(event) => setMine(event.target.checked)}
              />{" "}
              Я отвечаю за эту работу
            </label>
          )}
          {link && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={follows}
                  onChange={(event) => setFollows(event.target.checked)}
                />{" "}
                Ссылка следует за новыми версиями
              </label>
              <p className="ui-field-hint">
                Включено: агент без человека (сервисный доступ) может
                переставить ссылку на новую версию. Выключено: ссылка остаётся
                на своей версии, пока её не переставит человек.
              </p>
            </>
          )}
          {error && (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !revisions}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
