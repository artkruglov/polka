import type {
  AgentConnection,
  Artifact,
} from "../../../../../packages/contracts/index.ts";

export type FirstRunStepId = "agent" | "save" | "share";

export type FirstRunStep = {
  id: FirstRunStepId;
  done: boolean;
  /** What the data says once the step is done (or why the action is unavailable). */
  note: string | null;
};

export type FirstRunModel = {
  steps: FirstRunStep[];
  done: number;
  total: 3;
  complete: boolean;
  /** The first step still pending; null when everything is done. */
  next: FirstRunStepId | null;
  /** The work «Поделиться» opens: the first one a link can be issued for. */
  shareTarget: Artifact | null;
  /** A connection has been used and the shelf is not empty: the person came from an agent. */
  agentSaved: boolean;
};

const shortDate = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : null;

/** Mirrors entities/artifact/format.profileView without importing a sibling slice. */
const linkable = (a: Artifact) =>
  a.revision.mime !== "text/html" ||
  a.revision.htmlProfile === "static" ||
  a.revision.htmlProfile === "limited" ||
  a.revision.inlineBuild?.state === "ready";

const isActive = (c: AgentConnection) =>
  c.status === "issued" || c.status === "seen";

/**
 * The three first-run steps, derived only from what the API already returns:
 * the connection list and the (first page of the) shelf. Nothing here is set
 * by pressing a button.
 */
export function deriveFirstRun({
  connections,
  works,
}: {
  connections: AgentConnection[];
  works: Artifact[];
}): FirstRunModel {
  const seen = connections.find((c) => c.status === "seen");
  const active = seen ?? connections.find(isActive) ?? null;
  const agent: FirstRunStep = {
    id: "agent",
    done: active !== null,
    note: active
      ? active.status === "seen"
        ? `${active.name} · обращался к Полке${active.lastSeenAt && shortDate(active.lastSeenAt) ? ` ${shortDate(active.lastSeenAt)}` : ""}`
        : `${active.name} · доступ выдан, запросов пока нет`
      : null,
  };

  const first = works[0] ?? null;
  const save: FirstRunStep = {
    id: "save",
    done: first !== null,
    note: first
      ? `${first.title} · v${first.revision.number}${shortDate(first.updatedAt) ? ` · ${shortDate(first.updatedAt)}` : ""}`
      : null,
  };

  const shared =
    works.find((a) => a.share && ["active", "behind"].includes(a.share.status)) ??
    works.find((a) => a.share !== null) ??
    null;
  const shareTarget = shared ? null : (works.find(linkable) ?? null);
  const share: FirstRunStep = {
    id: "share",
    done: shared !== null,
    note: shared
      ? ["active", "behind"].includes(shared.share!.status)
        ? `Ссылка на «${shared.title}» действует до ${shortDate(shared.share!.expiresAt) ?? "срока"}`
        : `Ссылка на «${shared.title}» закрыта; новую можно создать в любой момент`
      : first && !shareTarget
        ? "Сохранённые страницы пока нельзя отправить ссылкой: нужен HTML без внешних ресурсов"
        : null,
  };

  const steps = [agent, save, share];
  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    total: 3,
    complete: done === 3,
    next: steps.find((s) => !s.done)?.id ?? null,
    shareTarget,
    agentSaved: seen !== undefined && first !== null,
  };
}

export const firstRunTitles: Record<FirstRunStepId, string> = {
  agent: "Подключите агента",
  save: "Сохраните первую работу",
  share: "Отправьте ссылку",
};
