import React, { useState } from "react";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { shelfName, useShelves } from "../../entities/shelf/model.ts";
import { ApiError, client, withShelf, type ShelfSnapshot } from "../../shared/api/client.ts";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { localInputValue, SnapshotList } from "./view.tsx";
import "./styles.css";

function snapshotError(error: unknown) {
  if (error instanceof ApiError && error.status === 400) return "Выберите момент в прошлом.";
  if (error instanceof ApiError && error.status === 404) return "Эта полка вам недоступна.";
  return error instanceof Error ? error.message : "Не удалось открыть полку на эту дату.";
}

/**
 * «Полка на дату» (docs/specs/SHELF_SNAPSHOT.md): the shelf this tab shows as
 * it stood at a chosen moment — each work's version then and the version
 * accepted then. Read-only: nothing here changes the shelf.
 */
export function ShelfSnapshotPage() {
  const { account, error: accountError, retry } = useAccountState();
  const shelves = useShelves(!!account && !account.provisional);
  const [moment, setMoment] = useState(() => localInputValue(new Date(Date.now() - 86_400_000)));
  const [page, setPage] = useState<ShelfSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function show(event?: React.FormEvent) {
    event?.preventDefault();
    const at = new Date(moment);
    if (!moment || Number.isNaN(at.getTime())) return setError("Укажите дату и время.");
    if (at.getTime() > Date.now()) return setError("Выберите момент в прошлом.");
    setBusy(true);
    setError("");
    try {
      setPage(await client.snapshot(at.toISOString()));
    } catch (e) {
      setPage(null);
      setError(snapshotError(e));
    } finally {
      setBusy(false);
    }
  }

  async function more() {
    if (!page?.nextCursor || busy) return;
    setBusy(true);
    try {
      const next = await client.snapshot(page.at, page.nextCursor);
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (e) {
      setError(snapshotError(e));
    } finally {
      setBusy(false);
    }
  }

  const name = shelfName(shelves.current);
  return (
    <AppShell current="shelf" account={account}>
      <main className="snapshot-page">
        <a className="snapshot-back" href={withShelf("/")}>
          ← {name}
        </a>
        <h1>Полка на дату</h1>
        <p className="snapshot-lead">
          Что лежало на полке «{name}» в выбранный момент: какая версия каждой работы была последней и какая была
          принята. Только для просмотра.
        </p>
        {account === undefined ? (
          accountError ? (
            <>
              <ErrorNotice error={`Не удалось проверить аккаунт. ${accountError}`} />
              <Button onClick={retry}>Проверить снова</Button>
            </>
          ) : (
            <p role="status">Проверяем аккаунт…</p>
          )
        ) : account === null ? (
          <LinkButton variant="primary" href="/?login=1&next=%2Fsnapshot">
            Войти
          </LinkButton>
        ) : (
          <>
            <form className="snapshot-form" onSubmit={show}>
              <div className="ui-field">
                <label htmlFor="snapshot-at">Дата и время</label>
                <input
                  id="snapshot-at"
                  className="ui-input"
                  type="datetime-local"
                  value={moment}
                  onFocus={(e) => (e.currentTarget.max = localInputValue(new Date()))}
                  onChange={(e) => setMoment(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" variant="primary" busy={busy && !page}>
                Показать
              </Button>
            </form>
            {error && <ErrorNotice error={error} />}
            {page && (
              <SnapshotList
                at={page.at}
                items={page.items}
                nextCursor={page.nextCursor}
                busy={busy}
                onMore={more}
                hrefFor={(item) => withShelf(`/works/${item.id}?revision=${item.revision.id}`)}
              />
            )}
            <p className="fine snapshot-fine">
              Названия и папки — нынешние: их история не хранится. Работы, которые в тот момент лежали в корзине, сюда
              не входят. Последняя минута ещё может измениться.
            </p>
          </>
        )}
      </main>
    </AppShell>
  );
}
