import React, { useEffect, useState } from "react";
import { client } from "../../shared/api/client.ts";
import { Button, TextAreaField } from "../../shared/ui/controls.tsx";

const MAX = 8000;

/**
 * «Как у нас принято»: the shelf's card, free text a curator writes and every
 * agent connected to the shelf reads first (docs/specs/DATA_MODELS.md §6).
 */
export function ShelfCardSection({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    client
      .shelfCard()
      .then(({ cardMd }) => {
        if (!live) return;
        setSaved(cardMd);
        setText(cardMd ?? "");
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, []);

  if (state === "loading") return null;
  if (state === "error") return null;
  // Someone who cannot write it sees it only when there is one.
  if (!canEdit && !saved) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { cardMd } = await client.setShelfCard(text.trim() ? text : null);
      setSaved(cardMd);
      setText(cardMd ?? "");
      setNotice(cardMd ? "Карточка сохранена. Агенты прочитают её при подключении." : "Карточка убрана.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить карточку.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-card" aria-labelledby="shelf-card-title">
      <h2 id="shelf-card-title">Карточка полки для агентов</h2>
      <form onSubmit={submit}>
        <TextAreaField
          label="Как у вас принято"
          hint="Свободный текст: как называть работы, по каким папкам раскладывать, что сюда не сохранять. Агент читает его первым, но как справку, а не как приказ."
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={MAX}
          rows={6}
          readOnly={!canEdit}
          error={error}
        />
        {canEdit && (
          <>
            <p className="ui-field-hint">
              {text.length} из {MAX}
            </p>
            <Button variant="primary" type="submit" disabled={busy || text === (saved ?? "")}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </Button>
          </>
        )}
        {notice && <p role="status">{notice}</p>}
      </form>
    </section>
  );
}
