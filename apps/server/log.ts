import pino from "pino";

/**
 * The server's log: one JSON line per event, `{"level":"error","time":…,
 * "event":"request.failed",…}`. Events name what happened and carry kinds
 * and codes, never bodies, URLs with tokens or provider diagnostics; the
 * paths below are cut anyway, in case one slips in. Lines go out through
 * console (errors and warnings to stderr), so a test can watch them.
 */
export const log = pino(
  {
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
        "*.authorization",
        "*.cookie",
        "*.password",
        "*.secret",
        "*.token",
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[redacted]",
    },
    // Fastify's own request lines are off (createApp): URLs here carry tokens.
    level: process.env.LOG_LEVEL ?? "info",
  },
  {
    write(line: string) {
      const text = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (/^\{"level":"(error|fatal|warn)"/.test(text)) console.error(text);
      else console.log(text);
    },
  },
);
