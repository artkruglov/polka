// The purge worker as a service: runs one purge pass a minute (a pass takes
// up to 100 object versions of one shelf and stops at 60 s) until it is
// stopped. This is what makes a confirmed «Удалить аккаунт» end in erased data
// (ACCOUNT_DELETION_PURGE_WORKER=true on the app); without it a request only
// closes the account. Its database role and the erasure ledger come from the
// environment like scripts/account-erase.ts (deploy/hosted/README.md).
import { runAccountPurgeCli } from "./account-purge-cli.ts";

const everyMs = Math.max(10_000, Number(process.env.ACCOUNT_PURGE_LOOP_SECONDS ?? 60) * 1000);
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());

// The worker's own flag: the app decides whether deletion is on (account-erase.ts does the same).
const env = { ...process.env, ACCOUNT_DELETION_ENABLED: "true" };
let failures = 0;
while (!stop.signal.aborted) {
  const exit = await runAccountPurgeCli({ env, signal: stop.signal });
  failures = exit === 0 ? 0 : failures + 1;
  // A failing pass (ledger or storage unreachable) backs off up to ten minutes.
  const wait = Math.min(everyMs * 2 ** Math.min(failures, 4), 600_000);
  await new Promise<void>((resolve) => {
    const done = () => (clearTimeout(timer), stop.signal.removeEventListener("abort", done), resolve());
    const timer = setTimeout(done, wait);
    stop.signal.addEventListener("abort", done, { once: true });
  });
}
