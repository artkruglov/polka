#!/usr/bin/env node
// The analytics shelf's agent journal as a table (GET /api/shelves/:id/agent-audit,
// docs/specs/TEAM_SHELVES.md «Журнал агентов»), and the human's acceptance
// of a version for the stand's scenario (deploy/agent-stand/README.md).
//
//   node deploy/agent-stand/journal.mjs --account <file> [--limit 20]
//   node deploy/agent-stand/journal.mjs --account <file> --accept <workId> [--revision <id>]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "http://127.0.0.1:4390" },
    account: { type: "string" },
    tokens: { type: "string", default: ".local/agent-stand/tokens.json" },
    limit: { type: "string", default: "20" },
    accept: { type: "string" },
    revision: { type: "string" },
  },
});
if (!values.account) throw new Error("--account <file> is required");
const { origin } = values;
const shelf = JSON.parse(await readFile(values.tokens, "utf8")).shelves.analytics;

let cookie = "";
async function call(method, path, body) {
  const response = await fetch(origin + path, {
    method,
    headers: { origin, cookie, "x-polka-shelf": shelf, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const line of response.headers.getSetCookie?.() ?? [])
    if (line.startsWith("polka_session=")) cookie = line.split(";")[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const account = JSON.parse(await readFile(values.account, "utf8"));
await call("POST", "/api/login", { name: account.name, password: account.password });

if (values.accept) {
  const work = await call("GET", `/api/artifacts/${values.accept}`);
  const revisionId = values.revision ?? work.revision?.id ?? work.latestRevisionId;
  await call("PUT", `/api/artifacts/${values.accept}/accepted`, { revisionId });
  console.log(`Принята версия ${revisionId} работы «${work.title}»`);
} else {
  const { items } = await call("GET", `/api/shelves/${shelf}/agent-audit?limit=${Number(values.limit)}`);
  const ACTION = {
    "revision.saved": "сохранил версию",
    "revision.read": "прочитал версию",
    "revision.accepted": "принял версию",
    "service_account.task_token": "выдан токен задачи",
    "service_account.created": "заведён сервисный доступ",
    "service_account.disabled": "отключён",
  };
  for (const item of items.reverse()) {
    // Who acted: the agent (its service account or connection), or the person.
    const who =
      item.actorType === "agent"
        ? (item.serviceAccount ?? item.connectionName)
        : `${item.responsible}${item.serviceAccount ? ` → ${item.serviceAccount}` : ""}`;
    console.log(
      [
        new Date(item.at).toLocaleTimeString("ru-RU"),
        (ACTION[item.action] ?? item.action).padEnd(26),
        who.padEnd(18),
        item.taskId ? `задача ${item.taskId}` : "",
        item.workId ? `работа ${item.workId.slice(0, 8)}` : "",
        item.actorType === "agent" && item.serviceAccount ? `ответственный ${item.responsible}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
}
