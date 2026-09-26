// An agent limited to some folders (docs/specs/EXTENSIONS.md, policies.
// agentScope): works outside them are «not found» to it, a new work goes into
// them, and it does not manage folders. Without an extension that limits a
// connection, every function here lets everything through.
import type { PoolClient } from "pg";
import { extensions } from "./extensions.ts";
import { Problem, missing } from "./errors.ts";

type Query = Pick<PoolClient, "query">;
type AgentActor = { id: string; tenant: string; connectionId?: string };

/** The folders this agent may touch, or null for the whole shelf. */
export async function agentFolderScope(c: Query, actor: AgentActor): Promise<string[] | null> {
  if (!actor.connectionId) return null;
  const hooks = extensions().filter((extension) => extension.policies?.agentScope);
  if (!hooks.length) return null;
  // A project upload token acts for the connection that asked for it.
  const {
    rows: [connection],
  } = await c.query("SELECT COALESCE(parent_id,id) AS root FROM agent_connections WHERE id=$1", [actor.connectionId]);
  if (!connection) return null;
  for (const extension of hooks) {
    const scope = await extension.policies!.agentScope!(
      { connectionId: connection.root, accountId: actor.id, tenantId: actor.tenant },
      c,
    );
    if (scope) return scope.folderIds;
  }
  return null;
}

/** For SQL: `($n::uuid[] IS NULL OR artifact.folder_id=ANY($n::uuid[]))`. */
export const inScopeSql = (alias: string, param: string) =>
  `(${param}::uuid[] IS NULL OR ${alias}.folder_id=ANY(${param}::uuid[]))`;

export async function assertArtifactInAgentScope(c: Query, actor: AgentActor, artifactId: string) {
  const scope = await agentFolderScope(c, actor);
  if (!scope) return;
  const {
    rows: [row],
  } = await c.query("SELECT folder_id FROM artifacts WHERE id=$1 AND tenant_id=$2", [artifactId, actor.tenant]);
  if (!row || !scope.includes(row.folder_id)) throw missing();
}

/** Where an agent's new work goes: its folder, or refused outside the scope. */
export async function scopedFolderForSave(
  c: Query,
  actor: AgentActor,
  folderId: string | null | undefined,
): Promise<string | null | undefined> {
  const scope = await agentFolderScope(c, actor);
  if (!scope) return folderId;
  if (folderId && scope.includes(folderId)) return folderId;
  if (!folderId && scope.length === 1) return scope[0];
  throw new Problem(
    403,
    "forbidden",
    "Этот агент подключён только к своей папке на полке: сохраняйте работы туда (folderId из polka_list_folders).",
  );
}

export async function refuseFolderManagement(c: Query, actor: AgentActor) {
  if (await agentFolderScope(c, actor))
    throw new Problem(403, "forbidden", "Агент, подключённый к папке, не создаёт, не переименовывает и не удаляет папки.");
}

/** Moving a work: only into the agent's folders, never out of them. */
export async function assertFolderInAgentScope(c: Query, actor: AgentActor, folderId: string | null) {
  const scope = await agentFolderScope(c, actor);
  if (scope && (!folderId || !scope.includes(folderId)))
    throw new Problem(403, "forbidden", "Этот агент подключён только к своей папке: переносить работы из неё нельзя.");
}
