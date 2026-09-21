import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { uuid } from "../packages/contracts/index.ts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const hash64 = z.string().regex(/^[0-9a-f]{64}$/);
const receiptSchema = z.object({
  uploadId: uuid,
  artifactId: uuid,
  revisionId: uuid,
  number: z.number().int().positive(),
  sha256: hash64,
  htmlProfile: z.enum(["static", "limited", "unsupported"]),
  manifestSha256: hash64,
  storageKind: z.literal("bundle"),
  totalSize: z.number().int().positive(),
});

const captureRequestSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(200),
    folderId: uuid.optional(),
    manifest: z.unknown(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(200),
            encoding: z.enum(["base64", "utf8"]),
            data: z.string().max(7_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

function endpointUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid endpoint");
  }
  if (url.username || url.password || url.protocol === "file:")
    throw new Error("invalid endpoint");
  if (url.protocol === "https:") return url;
  if (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
  )
    return url;
  throw new Error("endpoint must use HTTPS or loopback HTTP");
}

async function readRequestFile(filename: string): Promise<unknown> {
  const handle = await open(filename, "r");
  try {
    const initial = await handle.stat();
    if (!initial.isFile())
      throw new Error("request path is not a regular file");
    if (initial.size > MAX_REQUEST_BYTES)
      throw new Error("request file is too large");
    const bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_REQUEST_BYTES)
      throw new Error("request file is too large");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function validateCapture(value: unknown) {
  const input = captureRequestSchema.parse(value);
  const manifest = canonicalizeManifest(input.manifest);
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  if (
    new Set(input.files.map((file) => file.path)).size !== input.files.length ||
    input.files.length !== manifest.files.length ||
    input.files.some((file) => !manifestPaths.has(file.path))
  )
    throw new Error("request files do not match manifest");
  return { ...input, manifest };
}

async function run(filename: string, endpoint: string, token: string) {
  const request = validateCapture(await readRequestFile(filename));
  const url = endpointUrl(endpoint);
  const client = new Client(
    { name: "polka-capture-helper", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
      onInsufficientScope: "throw",
    });
    await client.connect(transport);
    const capture = await client.callTool({
      name: "polka_capture",
      arguments: request,
    });
    if (capture.isError) throw new Error("capture failed");
    const status = await client.callTool({
      name: "polka_status",
      arguments: { key: request.key },
    });
    if (status.isError) throw new Error("status failed");
    const { captureReceipt, statusReceipt } = validateSuccessfulReceipts(
      capture.structuredContent,
      status.structuredContent,
    );
    console.log(
      JSON.stringify({ capture: captureReceipt, status: statusReceipt }),
    );
  } finally {
    await client.close();
  }
}

function safeReceipt(value: unknown): Record<string, unknown> | null {
  const parsed = receiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeStatus(value: unknown): {
  uploadId: string;
  state: string;
  receipt: Record<string, unknown> | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.uploadId !== "string" || typeof source.state !== "string")
    return null;
  const receipt = source.receipt === null ? null : safeReceipt(source.receipt);
  if (source.receipt !== null && !receipt) return null;
  return { uploadId: source.uploadId, state: source.state, receipt };
}

function validateSuccessfulReceipts(
  captureValue: unknown,
  statusValue: unknown,
) {
  const captureReceipt = safeReceipt(captureValue);
  if (!captureReceipt) throw new Error("capture did not return a receipt");
  const statusReceipt = safeStatus(statusValue);
  if (
    !statusReceipt ||
    statusReceipt.state !== "saved" ||
    statusReceipt.uploadId !== captureReceipt.uploadId
  )
    throw new Error("status did not return a receipt");
  if (
    !statusReceipt.receipt ||
    JSON.stringify(statusReceipt.receipt) !== JSON.stringify(captureReceipt)
  )
    throw new Error("status receipt mismatch");
  return { captureReceipt, statusReceipt };
}

export {
  captureRequestSchema,
  endpointUrl,
  readRequestFile,
  safeReceipt,
  safeStatus,
  validateSuccessfulReceipts,
  validateCapture,
  run,
};

async function main() {
  const [filename, endpoint] = process.argv.slice(2);
  const token = process.env.POLKA_MCP_TOKEN;
  if (!token) {
    console.error(
      JSON.stringify({ ok: false, error: "POLKA_MCP_TOKEN is required" }),
    );
    process.exitCode = 1;
  } else if (!filename || !endpoint) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "usage: capture-via-mcp.ts REQUEST.json ENDPOINT",
      }),
    );
    process.exitCode = 1;
  } else {
    try {
      await run(filename, endpoint, token);
    } catch {
      console.error(JSON.stringify({ ok: false, error: "capture failed" }));
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  void main();
