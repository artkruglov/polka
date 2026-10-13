/**
 * A loader that runs once and hands every caller the same promise (a chunk
 * started early and the React.lazy that renders it). A failure is not kept:
 * the next call loads again.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      const current: Promise<T> = load().catch((error: unknown) => {
        if (pending === current) pending = null;
        throw error;
      });
      pending = current;
    }
    return pending;
  };
}
