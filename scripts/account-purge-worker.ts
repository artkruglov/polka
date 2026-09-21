import { runAccountPurgeCli } from "./account-purge-cli.ts";

process.exitCode = await runAccountPurgeCli();
