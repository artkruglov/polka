/** Filter untrusted child output before it reaches operator logs. */
export type SafeMaintenanceLog = {
  event:
    | "maintenance.started"
    | "maintenance.completed"
    | "maintenance.failed"
    | "maintenance.skipped";
  reason?:
    | "busy"
    | "deadline"
    | "stopping"
    | "guard_lost"
    | "database"
    | "storage"
    | "internal";
  durationMs?: number;
  expiredUploadsReconciled?: number;
  expiredDerivativesReconciled?: number;
  emailChallengesRemoved?: number;
};
const events = new Set([
  "maintenance.started",
  "maintenance.completed",
  "maintenance.failed",
  "maintenance.skipped",
]);
const reasons = new Set([
  "busy",
  "deadline",
  "stopping",
  "guard_lost",
  "database",
  "storage",
  "internal",
]);
const counters = [
  "durationMs",
  "expiredUploadsReconciled",
  "expiredDerivativesReconciled",
  "emailChallengesRemoved",
] as const;

export function createMaintenanceLogFilter(
  emit: (event: SafeMaintenanceLog) => void,
) {
  const maxLine = 4096,
    maxAccepted = 65536;
  let line: number[] = [],
    discarding = false,
    acceptedBytes = 0;
  function finishLine() {
    if (discarding || !line.length || acceptedBytes >= maxAccepted) {
      line = [];
      discarding = false;
      return;
    }
    const bytes = Buffer.from(line);
    line = [];
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || !events.has(value.event))
        return;
      const safe: SafeMaintenanceLog = { event: value.event };
      if (value.reason !== undefined) {
        if (!reasons.has(value.reason)) return;
        safe.reason = value.reason;
      }
      for (const key of counters)
        if (value[key] !== undefined) {
          if (!Number.isSafeInteger(value[key]) || value[key] < 0) return;
          safe[key] = value[key];
        }
      const size = Buffer.byteLength(JSON.stringify(safe)) + 1;
      if (acceptedBytes + size > maxAccepted) return;
      acceptedBytes += size;
      try {
        emit(safe);
      } catch {
        /* Logging must not break process supervision. */
      }
    } catch {
      /* Raw provider errors and non-JSON output are drained, never forwarded. */
    }
  }
  return {
    push(chunk: Uint8Array) {
      for (const byte of chunk) {
        if (byte === 10) {
          finishLine();
          continue;
        }
        if (discarding || acceptedBytes >= maxAccepted) continue;
        if (line.length === maxLine) {
          line = [];
          discarding = true;
          continue;
        }
        line.push(byte);
      }
    },
    end() {
      finishLine();
    },
  };
}
