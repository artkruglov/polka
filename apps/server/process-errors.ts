// Last-resort handlers of the server process (main.ts). A promise nobody
// awaited that rejects is logged and the process keeps serving: it is one
// lost background task, not a broken process. An exception nothing caught
// leaves the process in an unknown state: it is logged and the process
// exits, for the supervisor (Docker, systemd) to start a clean one.
import { errorFacts } from "./db.ts";
import { log } from "./log.ts";

type Target = Pick<NodeJS.Process, "on">;

export function installProcessErrorHandlers(
  target: Target = process,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  target.on("unhandledRejection", (reason: unknown) => {
    log.error({ event: "process.unhandled_rejection", ...errorFacts(reason) });
  });
  target.on("uncaughtException", (error: unknown) => {
    log.error({ event: "process.uncaught_exception", ...errorFacts(error) });
    exit(1);
  });
}
