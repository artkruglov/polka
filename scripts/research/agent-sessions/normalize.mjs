// One local agent session (Claude Code JSONL or a Codex rollout) as the
// session index of the agent sessions plan: facts, tool calls, commands,
// hosts, tokens and a secrets report. Streams the file; text is redacted
// before anything is kept, and no tool output is kept at all. Unknown record
// types are counted, never fatal. Dependency-free.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";

const NETWORK_TOOLS = /^(?:WebFetch|WebSearch|web_search|web_fetch)$/;
const EDIT_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/;
const READ_TOOLS = /^(?:Read|Grep|Glob|LS|view_image)$/;
const SHELL_TOOLS = /^(?:Bash|BashOutput|shell|shell_command|exec|exec_command|local_shell|unified_exec|write_stdin)$/;
const NETWORK_COMMAND = /\b(?:curl|wget|ssh|scp|rsync|nc|telnet|git\s+push|gh\s|npm\s+publish|docker\s+push|aws\s|gcloud\s|yc\s|psql\s|mysql\s|redis-cli|kubectl\s|helm\s|terraform\s)/;

export function toolKind(name) {
  if (name.startsWith("mcp__")) return "mcp";
  if (SHELL_TOOLS.test(name)) return "shell";
  if (EDIT_TOOLS.test(name)) return "edit";
  if (READ_TOOLS.test(name)) return "read";
  if (NETWORK_TOOLS.test(name)) return "web";
  if (/^(?:Task|Agent|spawn_agent|send_message)$/.test(name)) return "task";
  return "other";
}

/** argv0 and a template with values blanked: "git push --force <arg>". */
export function commandShape(command) {
  const first = command.trim().split(/\n|&&|\|\||;|\|/)[0].trim();
  const words = first.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++;
  const argv0 = basename(words[i] ?? "");
  const rest = words.slice(i + 1, i + 4).map((w) => (w.startsWith("-") ? w.replace(/=.*/, "=<v>") : /^[a-z][a-z-]{1,20}$/.test(w) ? w : "<arg>"));
  return { argv0, template: [argv0, ...rest].join(" ").slice(0, 120) };
}

export function hostsIn(text) {
  const hosts = new Set();
  for (const match of String(text).matchAll(/\b(?:https?|wss?|ssh|git|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/(?:[^@\s/'"]*@)?([a-z0-9.-]+\.[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3}|localhost)/gi))
    hosts.add(match[1].toLowerCase());
  for (const match of String(text).matchAll(/\b(?:ssh|scp|rsync)\s+(?:-\S+\s+)*(?:[\w.-]+@)?([a-z0-9.-]+\.[a-z]{2,24})/gi)) hosts.add(match[1].toLowerCase());
  return [...hosts].slice(0, 20);
}

const bytes = (value) => (value === undefined || value === null ? 0 : typeof value === "string" ? Buffer.byteLength(value) : Buffer.byteLength(JSON.stringify(value)));
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function newIndex(source, file) {
  return {
    schema: "polka-session-index/1",
    source,
    file: basename(file),
    sessionId: null,
    parentSessionId: null,
    cliVersion: null,
    project: { cwd: null, gitBranch: null, remote: null },
    models: {},
    permissionMode: null,
    startedAt: null,
    endedAt: null,
    turns: 0,
    prompts: 0,
    toolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costUSD: null,
    unknownRecordTypes: {},
    parseErrors: 0,
    rawBytes: 0,
  };
}

function seen(index, at) {
  const t = ms(at);
  if (!Number.isFinite(t)) return;
  if (index.startedAt === null || t < index.startedAt) index.startedAt = t;
  if (index.endedAt === null || t > index.endedAt) index.endedAt = t;
}

/** Text the person or the model wrote, redacted; only its size is kept. */
function scan(redactor, text, where) {
  if (typeof text === "string") redactor.redact(text, where);
  else if (text !== undefined && text !== null) redactor.redact(JSON.stringify(text), where);
}

export async function parseClaude(file, redactor) {
  const index = newIndex("claude-code", file);
  const calls = new Map();
  const seenMessages = new Set();
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    index.rawBytes += line.length + 1;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      index.parseErrors++;
      continue;
    }
    seen(index, record.timestamp);
    index.sessionId ??= record.sessionId ?? null;
    if (record.cwd) index.project.cwd ??= record.cwd;
    if (record.gitBranch) index.project.gitBranch ??= record.gitBranch;
    if (record.version) index.cliVersion ??= record.version;
    switch (record.type) {
      case "assistant": {
        const message = record.message ?? {};
        const id = message.id ?? record.requestId;
        if (message.model && message.usage && id && !seenMessages.has(id)) {
          seenMessages.add(id);
          const usage = message.usage;
          const model = (index.models[message.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
          model.input += usage.input_tokens ?? 0;
          model.output += usage.output_tokens ?? 0;
          model.cacheRead += usage.cache_read_input_tokens ?? 0;
          model.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        }
        for (const block of message.content ?? []) {
          if (block.type === "text") scan(redactor, block.text, "assistant_text");
          else if (block.type === "thinking") scan(redactor, block.thinking, "thinking");
          else if (block.type === "tool_use") {
            const kind = toolKind(block.name);
            const command = kind === "shell" ? String(block.input?.command ?? "") : "";
            scan(redactor, block.input, kind === "shell" ? "tool_input_command" : kind === "web" || kind === "mcp" ? "tool_input_network" : kind === "edit" ? "tool_input_file" : "tool_input");
            const call = {
              seq: index.toolCalls.length,
              t: ms(record.timestamp),
              tool: block.name,
              kind,
              mcpServer: block.name.startsWith("mcp__") ? block.name.split("__")[1] : null,
              status: "unknown",
              durationMs: null,
              inputBytes: bytes(block.input),
              outputBytes: 0,
              agent: record.isSidechain ? "subagent" : "main",
              ...(command ? commandShape(command) : {}),
              hosts: kind === "shell" ? hostsIn(command) : kind === "web" ? hostsIn(block.input?.url ?? block.input?.query ?? "") : [],
              network: kind === "web" || kind === "mcp" || (kind === "shell" && NETWORK_COMMAND.test(command)),
            };
            calls.set(block.id, call);
            index.toolCalls.push(call);
          }
        }
        break;
      }
      case "user": {
        const content = record.message?.content;
        if (typeof content === "string") {
          if (!record.isMeta) {
            index.prompts++;
            index.turns++;
          }
          scan(redactor, content, "user_prompt");
        } else if (Array.isArray(content))
          for (const block of content) {
            if (block.type === "tool_result") {
              const call = calls.get(block.tool_use_id);
              const where = call?.kind === "read" ? "file_read" : "tool_output";
              scan(redactor, block.content, where);
              if (call) {
                call.status = block.is_error ? "error" : record.toolUseResult?.interrupted ? "interrupted" : "ok";
                call.outputBytes = bytes(block.content);
                const done = ms(record.timestamp);
                if (Number.isFinite(done) && Number.isFinite(call.t)) call.durationMs = done - call.t;
              }
            } else if (block.type === "text") {
              index.prompts++;
              index.turns++;
              scan(redactor, block.text, "user_prompt");
            }
          }
        break;
      }
      case "permission-mode":
        index.permissionMode = record.permissionMode ?? index.permissionMode;
        break;
      case "cost-state":
        index.costUSD = record.totalCostUSD ?? index.costUSD;
        break;
      case "attachment":
      case "system":
      case "queue-operation":
      case "last-prompt":
      case "atis-latch":
      case "file-history-snapshot":
      case "mode":
      case "summary":
      case "custom-title":
      case "agent-name":
        break;
      default:
        index.unknownRecordTypes[record.type] = (index.unknownRecordTypes[record.type] ?? 0) + 1;
    }
  }
  finish(index);
  return index;
}

export async function parseCodex(file, redactor) {
  const index = newIndex("codex", file);
  const calls = new Map();
  let model = "unknown";
  let lastTotal = null;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    index.rawBytes += line.length + 1;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      index.parseErrors++;
      continue;
    }
    seen(index, record.timestamp);
    const p = record.payload ?? {};
    const kind = `${record.type}/${p.type ?? ""}`;
    switch (kind) {
      case "session_meta/":
        index.sessionId = p.id ?? p.session_id ?? index.sessionId;
        index.project.cwd ??= p.cwd ?? null;
        index.cliVersion ??= p.cli_version ?? null;
        index.project.gitBranch ??= p.git?.branch ?? null;
        index.project.remote ??= p.git?.repository_url ? String(p.git.repository_url).replace(/\/\/[^@/]*@/, "//") : null;
        break;
      case "turn_context/":
        model = p.model ?? model;
        index.permissionMode = `${p.approval_policy ?? "?"}/${typeof p.sandbox_policy === "object" ? (p.sandbox_policy?.type ?? p.sandbox_policy?.mode ?? "?") : (p.sandbox_policy ?? "?")}`;
        break;
      case "event_msg/task_started":
        index.turns++;
        break;
      case "event_msg/token_count":
        if (p.info?.total_token_usage) lastTotal = { model, usage: p.info.total_token_usage };
        break;
      case "response_item/message":
        if (p.role === "user") {
          const text = (p.content ?? []).map((c) => c.text ?? "").join("\n");
          // Injected context is not the person's prompt.
          if (!/^<(?:environment_context|user_instructions|permissions)/.test(text.trim())) index.prompts++;
          scan(redactor, text, "user_prompt");
        } else if (p.role === "assistant") scan(redactor, (p.content ?? []).map((c) => c.text ?? "").join("\n"), "assistant_text");
        break;
      case "response_item/reasoning":
        scan(redactor, (p.summary ?? []).map((s) => s.text ?? "").join("\n"), "thinking");
        break;
      case "response_item/function_call":
      case "response_item/custom_tool_call":
      case "response_item/web_search_call":
      case "response_item/local_shell_call": {
        const name = p.name ?? (p.type === "web_search_call" ? "web_search" : p.type === "local_shell_call" ? "local_shell" : "tool");
        let args = p.arguments ?? p.input ?? p.action ?? null;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            // custom tools (apply_patch) send plain text
          }
        }
        // Codex names an MCP tool by its server as the namespace (mcp__<server>).
        const toolKindName = p.namespace?.startsWith("mcp__") ? "mcp" : toolKind(name);
        const commandRaw = toolKindName === "shell" ? (Array.isArray(args?.cmd ?? args?.command) ? (args.cmd ?? args.command).join(" ") : String(args?.cmd ?? args?.command ?? (typeof args === "string" ? args : ""))) : "";
        const command = commandRaw.replace(/^(?:bash|zsh|sh) -l?c /, "");
        scan(redactor, args, toolKindName === "shell" ? "tool_input_command" : toolKindName === "web" || toolKindName === "mcp" ? "tool_input_network" : toolKindName === "edit" ? "tool_input_file" : "tool_input");
        const call = {
          seq: index.toolCalls.length,
          t: ms(record.timestamp),
          tool: p.namespace ? `${p.namespace}.${name}` : name,
          kind: toolKindName,
          mcpServer: p.namespace?.startsWith("mcp__") ? p.namespace.slice(5).replace(/_+$/, "") : null,
          status: p.type === "web_search_call" ? (p.status === "completed" ? "ok" : "unknown") : "unknown",
          durationMs: null,
          inputBytes: bytes(p.arguments ?? p.input),
          outputBytes: 0,
          agent: "main",
          ...(command ? commandShape(command) : {}),
          hosts: toolKindName === "shell" ? hostsIn(command) : toolKindName === "web" ? hostsIn(JSON.stringify(args ?? "")) : [],
          network: toolKindName === "web" || toolKindName === "mcp" || (toolKindName === "shell" && NETWORK_COMMAND.test(command)),
        };
        if (p.call_id) calls.set(p.call_id, call);
        index.toolCalls.push(call);
        break;
      }
      case "response_item/function_call_output":
      case "response_item/custom_tool_call_output":
      case "response_item/local_shell_call_output": {
        const call = calls.get(p.call_id);
        const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        scan(redactor, output, "tool_output");
        if (call) {
          const exit = /(?:Exit code|exit_code"?):?\s*(-?\d+)/i.exec(output);
          call.exitCode = exit ? Number(exit[1]) : null;
          call.status = exit && Number(exit[1]) !== 0 ? "error" : "ok";
          call.outputBytes = Buffer.byteLength(output);
          const done = ms(record.timestamp);
          if (Number.isFinite(done) && Number.isFinite(call.t)) call.durationMs = done - call.t;
        }
        break;
      }
      case "event_msg/item_completed":
      case "compacted/":
      case "world_state/":
      case "event_msg/task_complete":
      case "event_msg/turn_aborted":
      case "token_usage_record/":
      case "response_item/tool_search_call":
      case "response_item/tool_search_output":
      case "response_item/agent_message":
      case "event_msg/thread_settings_applied":
      case "event_msg/thread_goal_updated":
      case "inter_agent_communication_metadata/":
      case "event_msg/user_message":
      case "event_msg/agent_message":
      case "event_msg/agent_reasoning":
      case "event_msg/exec_command_end":
      case "event_msg/patch_apply_end":
        break;
      default:
        index.unknownRecordTypes[kind] = (index.unknownRecordTypes[kind] ?? 0) + 1;
    }
  }
  if (lastTotal) {
    const u = lastTotal.usage;
    index.models[lastTotal.model] = {
      input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
      output: u.output_tokens ?? 0,
      cacheRead: u.cached_input_tokens ?? 0,
      cacheWrite: u.cache_write_input_tokens ?? 0,
    };
    index.tokens.reasoning = u.reasoning_output_tokens ?? 0;
  }
  finish(index);
  return index;
}

function finish(index) {
  for (const m of Object.values(index.models)) {
    index.tokens.input += m.input;
    index.tokens.output += m.output;
    index.tokens.cacheRead += m.cacheRead;
    index.tokens.cacheWrite += m.cacheWrite;
  }
  index.project.label = index.project.cwd ? basename(index.project.cwd) : null;
}

/** Findings with their flags: what the model saw, ran, sent out or wrote. */
export function secretsReport(findings) {
  const items = findings.map((f) => {
    const w = f.where;
    return {
      ...f,
      seenByModel: !!(w.user_prompt || w.tool_output || w.file_read),
      modelEmitted: !!(w.assistant_text || w.thinking || w.tool_input || w.tool_input_command || w.tool_input_network || w.tool_input_file),
      toCommand: !!w.tool_input_command,
      toNetwork: !!w.tool_input_network,
      writtenToFile: !!w.tool_input_file,
    };
  });
  const status = items.some((i) => i.toNetwork) ? "sent_out" : items.some((i) => i.toCommand || i.writtenToFile) ? "used" : items.length ? "seen" : "clean";
  return { status, items };
}
