import "./styles.css";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useState } from "react";
import { ArrowUpRight, Compass, Flag, Link as LinkIcon, LockKeyhole } from "lucide-react";
import type { Viewer } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { dateTime, kindOf, profileView } from "../../entities/artifact/format.ts";
import { Button, Badge } from "../../shared/ui/controls.tsx";
import { ReportArtifactPanel } from "../../features/report-artifact/index.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import { CopyText } from "../../shared/ui/CopyText.tsx";

const accessRequest =
  "Привет! Ссылка на твою работу на Полке у меня не открывается — возможно, ты её отозвал или истёк срок. Пришлёшь новую?";

export function Recipient() {
  const [token, setToken] = useState(() => location.hash.slice(1));
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const nextToken = location.hash.slice(1);
      const requestGeneration = ++generation;
      setToken(nextToken);
      setViewer(null);
      setError("");
      client
        .resolve(nextToken)
        .then((nextViewer) => {
          if (active && requestGeneration === generation) setViewer(nextViewer);
        })
        .catch(() => {
          if (active && requestGeneration === generation)
            setError("Работа по этой ссылке недоступна");
        });
    };
    load();
    window.addEventListener("hashchange", load);
    return () => {
      active = false;
      window.removeEventListener("hashchange", load);
    };
  }, []);
  return (
    <RecipientScreen key={token} viewer={viewer} error={error} token={token} />
  );
}

/** What a link opens: the fixed version, its provenance, and a way to report it. */
function RecipientScreen({
  viewer,
  error,
  token,
}: {
  viewer: Viewer | null;
  error: string;
  token: string;
}) {
  const account = useAccount();
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const plainText = viewer?.revision.mime === "text/plain";
  return (
    <AppShell
      current="shelf"
      account={account}
      className="recipient recipient-reader"
    >
      {error ? (
        <main className="empty recipient-denied">
          <div className="empty-icon"><LockKeyhole /></div>
          <h1>{error}</h1>
          <p>
            Владелец мог отозвать ссылку, у неё мог истечь срок, или адрес
            скопирован не полностью. Мы не показываем, была ли здесь работа.
          </p>
          <div className="recipient-request">
            <strong>Запросить новую ссылку у владельца</strong>
            <small>
              Полка не знает, кто прислал вам ссылку. Отправьте владельцу это
              сообщение там, где получили ссылку.
            </small>
            <CopyText
              value={accessRequest}
              label="Сообщение владельцу"
              rows={3}
            />
          </div>
          <a className="recipient-explore" href="/discover">
            <Compass /> Посмотреть публичные примеры
          </a>
        </main>
      ) : viewer ? (
        <main className="recipient-main">
          <div className="recipient-bar">
            <Badge tone="accent">
              <LinkIcon /> Открыто по ссылке
            </Badge>
            <span>
              {kindOf(viewer.revision)} · {dateTime(viewer.revision.createdAt)}
            </span>
            {viewer.revision.mime === "text/html" && (
              <span
                className="recipient-reader-profile"
                data-profile={viewer.revision.htmlProfile ?? "file"}
              >
                {viewer.revision.inlineBuild?.state === "ready"
                  ? "Интерактивная версия"
                  : viewer.revision.htmlProfile === "limited"
                  ? "Статичный просмотр · интерактивные действия отключены"
                  : profileView(viewer.revision).badge}
              </span>
            )}
          </div>
          {!plainText && (
            <header className="recipient-heading">
              <h1>{viewer.title}</h1>
            </header>
          )}
          <div className="stage" data-kind={plainText ? "text" : viewer.revision.mime.startsWith("image/") ? "image" : "page"}>
            <Preview
              revision={viewer.revision}
              grant={viewer.grant}
              readingTitle={plainText ? viewer.title : undefined}
            />
          </div>
          <footer className="recipient-reader-footer">
            <div className="recipient-reader-provenance">
              <p>
                Сохранённая версия зафиксирована. Владелец может обновить или
                отозвать ссылку.
              </p>
              <small>
                Копия с Полки · аккаунт в исходном сервисе не нужен · содержание
                не проверено Полкой.
              </small>
            </div>
            <div className="recipient-reader-footer-actions">
              <a href="/">
                Что такое Полка <ArrowUpRight size={15} />
              </a>
              {reported ? (
                <span className="report-sent">Жалоба отправлена</span>
              ) : (
                <Button
                  variant="quiet"
                  className="report-button"
                  onClick={() => {
                    setReporting(true);
                  }}
                >
                  <Flag /> Пожаловаться
                </Button>
              )}
            </div>
          </footer>
          {reporting && (
            <ReportArtifactPanel
              token={token}
              onClose={() => setReporting(false)}
              onSent={() => setReported(true)}
            />
          )}
        </main>
      ) : (
        <main className="empty" role="status">
          Открываем работу…
        </main>
      )}
    </AppShell>
  );
}
