import type {
  Account,
  Artifact,
  Folder,
  Receipt,
  Revision,
  UploadInput,
  Viewer,
} from "../../../packages/contracts/index.ts";
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
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  shelf: (q: string, folderId: string | null, cursor?: string) =>
    request<{ items: Artifact[]; nextCursor: string | null }>(
      `/artifacts?${new URLSearchParams({ q, ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) })}`,
    ),
  artifact: (id: string) => request<Artifact>(`/artifacts/${id}`),
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
};
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
