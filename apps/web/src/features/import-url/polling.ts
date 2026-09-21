/** Only one request per poller; stopping fences pending responses as well as timers. */
export function pollImport<T>({
  read,
  onValue,
  onError,
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
}: {
  read: () => Promise<T>;
  onValue: (value: T) => number | null;
  onError: (error: unknown) => number | null;
  schedule?: (fn: () => void, delay: number) => () => void;
}) {
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  const next = (delay: number | null) => {
    if (!stopped && delay !== null)
      cancelTimer = schedule(() => void tick(), delay);
  };
  async function tick() {
    try {
      const value = await read();
      if (!stopped) next(onValue(value));
    } catch (error) {
      if (!stopped) next(onError(error));
    }
  }
  void tick();
  return () => {
    stopped = true;
    cancelTimer?.();
  };
}
