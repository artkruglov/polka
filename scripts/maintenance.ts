import { runMaintenanceCli } from "./maintenance-cli.ts";

process.exitCode = await runMaintenanceCli();
