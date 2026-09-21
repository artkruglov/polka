// Benign subprocess fixture: never imports or runs maintenance or application code.
const alive = setInterval(() => undefined, 1000);
process.on("SIGTERM", () => {
  clearInterval(alive);
  console.log(
    JSON.stringify({
      event: "maintenance.failed",
      reason: "stopping",
      durationMs: 1,
    }),
  );
});

// Signal readiness only after the shutdown handler is installed.
console.error("private diagnostic: must not be forwarded");
console.log(
  JSON.stringify({ event: "maintenance.started", secret: "must be stripped" }),
);
