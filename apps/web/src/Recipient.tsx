import React, { useEffect, useState } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import type { Viewer } from "../../../packages/contracts/index.ts";
import { client } from "./client.ts";
import { date } from "./format.ts";
import { Brand } from "./ui.tsx";
import { Preview } from "./Preview.tsx";
export function Recipient() {
  const [viewer, setViewer] = useState<Viewer | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    client
      .resolve(location.hash.slice(1))
      .then((v) => live && setViewer(v))
      .catch(() => live && setError("Материал недоступен"));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="recipient">
      <header>
        <Brand />
        {viewer && (
          <span className="pill">Версия {viewer.revision.number}</span>
        )}
      </header>
      {error ? (
        <div className="empty">
          <LockKeyhole />
          <h1>{error}</h1>
          <p>Попросите автора проверить ссылку и доступ.</p>
          <a className="button primary" href="/">
            Открыть свою полку
            <ArrowUpRight />
          </a>
        </div>
      ) : viewer ? (
        <main>
          <div className="recipient-heading">
            <h1>{viewer.title}</h1>
            <span>{date(viewer.revision.createdAt)}</span>
          </div>
          <div className="stage">
            <Preview revision={viewer.revision} grant={viewer.grant} />
          </div>
          <footer>Материал на Полке · открыт без исходного агента</footer>
        </main>
      ) : (
        <div className="empty" role="status">
          Открываем материал…
        </div>
      )}
    </div>
  );
}
