import React, { useEffect, useState } from "react";
import type { Artifact, Revision } from "../../../../../packages/contracts/index.ts";
import type { FeedProposal } from "../../../../../packages/contracts/feed-proposal.ts";
import { client } from "../../shared/api/client.ts";
import { Button, Notice, SelectField, TextField } from "../../shared/ui/controls.tsx";
import { Dialog } from "../../shared/ui/index.tsx";

/** What the shelf sees about its proposal (docs/specs/DISCOVER_V2.md). */
export function proposalStatus(proposal: FeedProposal): string {
  const version = `версия ${proposal.revisionNumber}`;
  switch (proposal.state) {
    case "pending":
      return `Предложено в Ленту (${version}). Ждёт решения Редакции.`;
    case "published":
      return `Редакция взяла работу в Ленту (${version}).`;
    case "rejected":
      return `Редакция не взяла работу в Ленту (${version}).`;
    case "withdrawn":
      return `Предложение (${version}) отозвано.`;
  }
}

export type ProposalDraft = {
  revisionId: string;
  title: string;
  summary: string;
  rights: boolean;
  noPersonalData: boolean;
};

/** The dialog's content without loading: the state, then the form when one may propose again. */
export function FeedProposalBody({
  proposal,
  revisions,
  draft,
  setDraft,
  error,
}: {
  proposal: FeedProposal | null;
  revisions: Revision[];
  draft: ProposalDraft;
  setDraft: (next: ProposalDraft) => void;
  error: string;
}) {
  const pending = proposal?.state === "pending";
  return (
    <div className="dialog-body artifact-metadata-form">
      {proposal && (
        <Notice>
          {proposalStatus(proposal)}
          {proposal.state === "rejected" && proposal.reason && <> Причина: {proposal.reason}</>}
        </Notice>
      )}
      {!pending && (
        <>
          <p className="ui-field-hint">
            Лента — подборка Редакции Полки, её видят все. Редакция проверит
            работу по своему чек-листу и, если она подходит, опубликует копию
            выбранной версии. Новые версии в Ленту сами не попадают.
          </p>
          <SelectField
            label="Версия"
            value={draft.revisionId}
            onChange={(event) => setDraft({ ...draft, revisionId: event.target.value })}
          >
            {revisions.map((revision) => (
              <option value={revision.id} key={revision.id}>
                Версия {revision.number}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Заголовок в Ленте"
            value={draft.title}
            maxLength={120}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <TextField
            label="Что узнает читатель"
            hint="Одна строка, до 200 символов."
            value={draft.summary}
            maxLength={200}
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
          />
          <label>
            <input
              type="checkbox"
              checked={draft.rights}
              onChange={(event) => setDraft({ ...draft, rights: event.target.checked })}
            />{" "}
            Отдел вправе показывать эту работу всем
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.noPersonalData}
              onChange={(event) => setDraft({ ...draft, noPersonalData: event.target.checked })}
            />{" "}
            В работе нет чужих персональных данных и сведений только для компании
          </label>
        </>
      )}
      {error && (
        <p className="ui-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A curator or admin of a department shelf proposes a version of the work to
 * «Лента»; the operator decides. Shows where the last proposal stands.
 */
export function ProposeToFeedPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [proposal, setProposal] = useState<FeedProposal | null | undefined>(undefined);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [draft, setDraft] = useState<ProposalDraft>({
    revisionId: artifact.acceptedRevisionId ?? artifact.revision.id,
    title: artifact.title,
    summary: "",
    rights: false,
    noPersonalData: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([client.feedProposal(artifact.id), client.revisions(artifact.id)])
      .then(([found, list]) => {
        if (!live) return;
        setProposal(found.proposal);
        setRevisions(list);
      })
      .catch(() => live && setError("Не удалось загрузить предложение."));
    return () => {
      live = false;
    };
  }, [artifact.id]);

  const run = async (action: () => Promise<{ proposal: FeedProposal }>) => {
    setBusy(true);
    setError("");
    try {
      setProposal((await action()).proposal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отправить.");
    } finally {
      setBusy(false);
    }
  };
  const pending = proposal?.state === "pending";
  const ready =
    !!revisions && draft.title.trim() && draft.summary.trim() && draft.rights && draft.noPersonalData;

  return (
    <Dialog title="Предложить в Ленту" busy={busy} onClose={() => !busy && onClose()}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || pending) return;
          void run(() =>
            client.proposeToFeed(artifact.id, {
              revisionId: draft.revisionId,
              title: draft.title,
              summary: draft.summary,
              rights: true,
              noPersonalData: true,
            }),
          );
        }}
      >
        {proposal === undefined || !revisions ? (
          <div className="dialog-body">
            {error ? <Notice tone="error">{error}</Notice> : <p role="status">Загружаем…</p>}
          </div>
        ) : (
          <FeedProposalBody
            proposal={proposal}
            revisions={revisions}
            draft={draft}
            setDraft={setDraft}
            error={error}
          />
        )}
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>
            Закрыть
          </Button>
          {pending ? (
            <Button busy={busy} onClick={() => void run(() => client.withdrawFeedProposal(artifact.id))}>
              Отозвать предложение
            </Button>
          ) : (
            <Button variant="primary" type="submit" busy={busy} disabled={!ready}>
              Предложить
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
