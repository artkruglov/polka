import type {
  Account,
  Artifact,
  Folder,
  Receipt,
  Revision,
  UploadInput,
  Viewer,
  Resolved,
  AgentConnection,
  AgentScope,
  OAuthConsentDetails,
} from "../../../../../packages/contracts/index.ts";
import type { ReportReason } from "../../../../../packages/contracts/constants.ts";
export type ModerationInspection = {
  action: string;
  actionLabel: string;
  effect: string;
  tokenExpiresAt: string;
  share: {
    id: string;
    title: string;
    mime: string;
    htmlProfile: string | null;
    version: number;
    state: "none" | "held" | "paused" | "closed";
    reason: string | null;
    signals: string | null;
  };
  author: {
    label: string;
    operatorCreated: boolean;
    createdAt: string | null;
    trusted: boolean;
    disabled: boolean;
  };
  reports: Array<{
    reason: string;
    comment: string | null;
    settled: boolean;
    createdAt: string;
  }>;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** What the person sees when a proxy or the network answers instead of Полка. */
function fallbackMessage(status: number) {
  if (status === 0)
    return "Нет связи с Полкой. Проверьте подключение и повторите попытку.";
  if (status === 413) return "Файл слишком большой для сервера.";
  if (status === 429)
    return "Слишком много запросов. Подождите немного и повторите.";
  if (status >= 500)
    return "Полка временно недоступна. Повторите попытку через минуту.";
  return "Не удалось выполнить запрос.";
}

/**
 * Every browser request goes through here. The status is checked before the
 * body is read, so an HTML error page from a proxy never reaches the UI raw.
 * A network failure becomes ApiError with status 0.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new ApiError(0, "network", fallbackMessage(0));
  }
  if (res.ok) return res;
  let problem: { code?: unknown; message?: unknown } = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") problem = parsed;
  } catch {
    // An intermediary answered with HTML or nothing; keep the HTTP status.
  }
  throw new ApiError(
    res.status,
    typeof problem.code === "string" ? problem.code : "http_error",
    typeof problem.message === "string" && problem.message
      ? problem.message
      : fallbackMessage(res.status),
  );
}

async function json<T>(
  url: string,
  body: unknown,
  method: Method,
  signal?: AbortSignal,
  csrfToken?: string,
): Promise<T> {
  const res = await send(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(csrfToken ? { "x-polka-csrf": csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  try {
    return await res.json();
  } catch {
    throw new ApiError(
      res.status,
      "invalid_response",
      "Сервер вернул некорректный ответ. Повторите попытку.",
    );
  }
}

/** JSON API under /api. */
export function request<T>(
  path: string,
  body?: unknown,
  method: Method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
  csrfToken?: string,
): Promise<T> {
  return json<T>(`/api${path}`, body, method, signal, csrfToken);
}

export const client = {
  me: () => request<Account>("/me"),
  login: (name: string, password: string) =>
    request("/login", { name, password }),
  logout: () => request("/logout", {}),
  folders: () => request<Folder[]>("/folders"),
  createFolder: (name: string) => request<Folder>("/folders", { name }),
  updateArtifactMetadata: (
    id: string,
    input: {
      title?: string;
      folderId?: string | null;
      expectedTitle: string;
      expectedFolderId: string | null;
    },
  ) => request<Artifact>(`/artifacts/${id}`, input, "PATCH"),
  shelf: (q: string, folderId: string | null, cursor?: string) =>
    request<{ items: Artifact[]; nextCursor: string | null }>(
      `/artifacts?${new URLSearchParams({ q, ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) })}`,
    ),
  trash: (cursor?: string) =>
    request<{ items: Artifact[]; nextCursor: string | null }>(
      `/trash${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
    ),
  artifact: (id: string) => request<Artifact>(`/artifacts/${id}`),
  restoreArtifact: (
    id: string,
    input: { expectedLifecycleVersion: number; expectedRevisionId: string },
  ) =>
    request<{ id: string; trashedAt: string | null; lifecycleVersion: number }>(
      `/artifacts/${id}/restore`,
      input,
    ),
  trashArtifact: (
    id: string,
    input: { expectedLifecycleVersion: number; expectedRevisionId: string },
  ) =>
    request<{ id: string; trashedAt: string; lifecycleVersion: number }>(
      `/artifacts/${id}/trash`,
      input,
    ),
  revisions: (id: string) => request<Revision[]>(`/artifacts/${id}/revisions`),
  begin: (input: UploadInput) =>
    request<{ uploadId: string; receipt: Receipt | null }>("/uploads", input),
  finalize: (id: string) => request<Receipt>(`/uploads/${id}/finalize`, {}),
  enable: (a: Artifact, days: number) =>
    request<Artifact>(`/artifacts/${a.id}/share`, {
      expectedRevisionId: a.revision.id,
      expiresInDays: days,
    }),
  revoke: (id: string) => request(`/shares/${id}/revoke`, {}),
  publish: (a: Artifact) =>
    request(`/shares/${a.share!.id}/publish`, {
      revisionId: a.revision.id,
      expectedPublishedRevisionId: a.share!.revisionId,
    }),
  resolve: (token: string) => request<Resolved>("/resolve", { token }),
  /** One-click moderation from the operator's mail: the token is the capability. */
  moderation: {
    inspect: (token: string) =>
      request<ModerationInspection>("/moderation/inspect", { token }),
    preview: (token: string) =>
      request<Viewer>("/moderation/preview", { token }),
    act: (token: string) =>
      request<{ action: string; shareId: string; changed: boolean; message: string }>(
        "/moderation/act",
        { token },
      ),
  },
  report: (
    token: string,
    reason: ReportReason,
    comment?: string,
    key: string = crypto.randomUUID(),
  ) =>
    request<{ ok: true }>("/reports", {
      key,
      token,
      reason,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    }),
  agentConnections: {
    list: (signal?: AbortSignal) =>
      request<AgentConnection[]>(
        "/agent-connections",
        undefined,
        "GET",
        signal,
      ),
    csrf: (signal?: AbortSignal) =>
      request<{ csrfToken: string; expiresAt: string }>(
        "/agent-connections/csrf",
        {},
        "POST",
        signal,
      ),
    issue: (
      input: {
        name: string;
        scopes: AgentScope[];
        audience: string;
        ttlDays: number;
      },
      csrfToken: string,
      signal?: AbortSignal,
    ) =>
      request<{ connection: AgentConnection; token: string }>(
        "/agent-connections",
        input,
        "POST",
        signal,
        csrfToken,
      ),
    revoke: (id: string, csrfToken: string, signal?: AbortSignal) =>
      request<{ ok: true }>(
        `/agent-connections/${id}/revoke`,
        {},
        "POST",
        signal,
        csrfToken,
      ),
  },
};

/** Connector consent lives under /oauth, next to the authorization endpoint. */
export const oauthConsent = {
  details: (requestId: string, signal?: AbortSignal) =>
    json<OAuthConsentDetails>(
      `/oauth/authorize/details?${new URLSearchParams({ request: requestId })}`,
      undefined,
      "GET",
      signal,
    ),
  decide: (
    input:
      | { request: string; decision: "approve"; scopes: AgentScope[] }
      | { request: string; decision: "deny" },
    csrfToken: string,
    signal?: AbortSignal,
  ) =>
    json<{ redirectTo: string }>(
      "/oauth/authorize/decision",
      input,
      "POST",
      signal,
      csrfToken,
    ),
};

export async function bytes(
  path: string,
  grant?: string,
  signal?: AbortSignal,
) {
  const response = await send(`/api${path}`, {
    headers: grant ? { Authorization: `Bearer ${grant}` } : {},
    signal,
  });
  return response.blob();
}

/**
 * Where the static (scriptless) view of saved HTML loads from: a short-lived
 * address on the viewer domain when the install has one, else an app route.
 */
export async function staticView(
  revisionId: string,
  grant?: string,
  signal?: AbortSignal,
) {
  const response = await send(
    grant
      ? "/api/view/static-view"
      : `/api/revisions/${revisionId}/static-view`,
    {
      method: "POST",
      headers: grant ? { Authorization: `Bearer ${grant}` } : {},
      signal,
    },
  );
  const result = (await response.json()) as { url?: unknown };
  if (typeof result.url !== "string" || !result.url)
    throw new ApiError(
      response.status,
      "invalid_response",
      "Сервер вернул некорректный ответ. Повторите попытку.",
    );
  return result.url;
}

export type PendingUpload = { file: Blob; key: string; id?: string };
/** begin → bytes → finalize. Reusing `op` after a failure retries the same upload key. */
export async function saveUpload(
  op: PendingUpload,
  input: Omit<UploadInput, "key" | "mime" | "size" | "sha256">,
  stage: (label: string) => void,
): Promise<Receipt> {
  stage("Подготавливаем файл…");
  const sha = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await op.file.arrayBuffer()),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (!op.id) {
    const started = await client.begin({
      ...input,
      key: op.key,
      mime: op.file.type as UploadInput["mime"],
      size: op.file.size,
      sha256: sha,
    });
    op.id = started.uploadId;
    if (started.receipt) return started.receipt;
  }
  stage("Передаём файл…");
  await send(`/api/uploads/${op.id}/bytes`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: op.file,
  });
  stage("Сохраняем версию…");
  return client.finalize(op.id);
}
