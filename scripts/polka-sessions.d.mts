// Types of scripts/polka-sessions.mjs for the tests and the server (the CLI itself stays plain JS).
export type LocalSession = { source: "claude-code" | "codex"; path: string; id: string; size?: number; mtimeMs?: number };
export type Redactor = {
  redact(text: string, where?: string): string;
  findings(): Array<{ type: string; confidence: string; fp: string; prefix: string; length: number; occurrences: number; where: Record<string, number> }>;
  samples(): unknown[];
};
export const MAX_TOOL_CALLS: number;
export const RULES: Array<{ type: string; confidence: string; group?: number; re: RegExp }>;
export function createRedactor(key: Buffer | string): Redactor;
export function toolKind(name: string): string;
export function commandShape(command: string): { argv0: string; template: string };
export function hostsIn(text: string): string[];
export function parseClaude(file: string, redactor: Redactor, options?: { transcript?: unknown[] | null; thinking?: boolean }): Promise<any>;
export function parseCodex(file: string, redactor: Redactor, options?: { transcript?: unknown[] | null; thinking?: boolean }): Promise<any>;
export function secretsReport(findings: ReturnType<Redactor["findings"]>): { status: string; items: any[] };
export function localSessions(options?: { source?: "claude" | "codex"; since?: number }): Promise<LocalSession[]>;
export function prepareSession(
  file: LocalSession,
  key: Buffer,
  options?: { thinking?: boolean },
): Promise<{ body: any; transcriptGz: Buffer; index: any; report: { status: string; items: any[] } }>;
export function main(
  argv?: string[],
  io?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    stdout?: { write(text: string): unknown };
    stderr?: { write(text: string): unknown };
    stdin?: () => Promise<string>;
  },
): Promise<number>;
