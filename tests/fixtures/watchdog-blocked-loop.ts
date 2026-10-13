// A process whose event loop blocks (tests/watchdog.test.ts):
// argv: <limit ms> <block ms>. Prints "survived" if the watchdog let it live.
import { startEventLoopWatchdog } from "../../apps/server/watchdog.ts";

const [limitMs, blockMs] = process.argv.slice(2).map(Number);
startEventLoopWatchdog({ limitMs: limitMs!, checkMs: 100 });
setTimeout(() => {
  const end = Date.now() + blockMs!;
  while (Date.now() < end);
  console.log("survived");
}, 300);
