import React, { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { SECRETS_LABEL, SOURCE_LABEL, formatWhen, sessionUrl, sessionsApi, type AgentSession } from "./model.ts";

type Linked = Pick<AgentSession, "id" | "source" | "projectLabel" | "startedAt" | "secretsStatus">;

/** «Сделано в сессии»: the owner's sessions that saved this work. Nothing when there are none. */
export function WorkSessionsList({ sessions }: { sessions: Linked[] }) {
  if (!sessions.length) return null;
  return (
    <section className="work-sessions" aria-label="Сделано в сессии">
      <h2>
        <Bot aria-hidden="true" /> Сделано в сессии
      </h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <a href={sessionUrl(session.id)}>
              {SOURCE_LABEL[session.source]}
              {session.projectLabel ? ` · ${session.projectLabel}` : ""} · {formatWhen(session.startedAt)}
            </a>
            {session.secretsStatus !== "clean" && <small> — {SECRETS_LABEL[session.secretsStatus]}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WorkSessions({ artifactId }: { artifactId: string }) {
  // Tagged with the work they belong to: another work starts empty until its answer.
  const [loaded, setLoaded] = useState<{ artifactId: string; sessions: Linked[] } | null>(null);
  useEffect(() => {
    let live = true;
    sessionsApi
      .ofWork(artifactId)
      .then((page) => live && setLoaded({ artifactId, sessions: page.sessions }))
      // A shelf without sessions, or someone else's: the block stays empty.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [artifactId]);
  return <WorkSessionsList sessions={loaded?.artifactId === artifactId ? loaded.sessions : []} />;
}
