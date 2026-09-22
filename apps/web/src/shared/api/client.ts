import type {
  Account,
  Artifact,
  Folder,
  Receipt,
  Revision,
  UploadInput,
  Viewer,
  AgentConnection,
  AgentScope,
  OAuthConsentDetails,
} from "../../../../../packages/contracts/index.ts";
import type { REPORT_REASONS } from "../../../../../packages/contracts/index.ts";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await res.json();
  if (!res.ok) throw new ApiError(res.status, result.code, result.message);
  return result;
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
  resolve: (token: string) => request<Viewer>("/resolve", { token }),
  report: (
    token: string,
    reason: (typeof REPORT_REASONS)[number],
    comment?: string,
  ) =>
    request<{ ok: true }>("/reports", {
      key: crypto.randomUUID(),
      token,
      reason,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    }),
  agentConnections: {
    list: (signal?: AbortSignal) =>
      agentRequest<AgentConnection[]>(
        "/agent-connections",
        undefined,
        "GET",
        signal,
      ),
    csrf: (signal?: AbortSignal) =>
      agentRequest<{ csrfToken: string; expiresAt: string }>(
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
      agentRequest<{ connection: AgentConnection; token: string }>(
        "/agent-connections",
        input,
        "POST",
        signal,
        csrfToken,
      ),
    revoke: (id: string, csrfToken: string, signal?: AbortSignal) =>
      agentRequest<{ ok: true }>(
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
    jsonRequest<OAuthConsentDetails>(
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
    jsonRequest<{ redirectTo: string }>(
      "/oauth/authorize/decision",
      input,
      "POST",
      signal,
      csrfToken,
    ),
};

export function agentRequest<T>(
  path: string,
  body: unknown,
  method: "GET" | "POST",
  signal?: AbortSignal,
  csrfToken?: string,
): Promise<T> {
  return jsonRequest<T>(`/api${path}`, body, method, signal, csrfToken);
}

async function jsonRequest<T>(
  url: string,
  body: unknown,
  method: "GET" | "POST",
  signal?: AbortSignal,
  csrfToken?: string,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(csrfToken ? { "x-polka-csrf": csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let result: { code?: unknown; message?: unknown } = {};
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === "object") result = parsed;
    } catch {
      // Preserve the HTTP status when an intermediary returns an empty/HTML error.
    }
    throw new ApiError(
      res.status,
      typeof result.code === "string" ? result.code : "http_error",
      typeof result.message === "string"
        ? result.message
        : "Не удалось выполнить запрос.",
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error("Некорректный ответ сервера.");
  }
}
export async function bytes(
  path: string,
  grant?: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api${path}`, {
    headers: grant ? { Authorization: `Bearer ${grant}` } : {},
    signal,
  });
  if (!response.ok) {
    const e = await response.json();
    throw new ApiError(response.status, e.code, e.message);
  }
  return response.blob();
}
// Browsers may report an empty or generic type for downloaded files; use the
// extension as a hint, while the server still checks the real bytes.
export function fileMime(file: File) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  if (/\.html?$/i.test(file.name)) return "text/html";
  if (/\.txt$/i.test(file.name)) return "text/plain";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return file.type;
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
  await transfer(op.id, op.file);
  stage("Сохраняем версию…");
  return client.finalize(op.id);
}
export async function transfer(id: string, file: Blob) {
  const response = await fetch(`/api/uploads/${id}/bytes`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) {
    const e = await response.json();
    throw new ApiError(response.status, e.code, e.message);
  }
}
