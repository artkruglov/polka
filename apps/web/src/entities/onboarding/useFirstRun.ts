import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentConnection,
  Artifact,
} from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";

export type Loaded<T> =
  | { status: "loading"; value: T }
  | { status: "ready"; value: T }
  | { status: "error"; value: T; error: string };

/**
 * The data behind the first-run steps. Connections are always fetched here;
 * the shelf page passes the works it already shows, /start lets the hook
 * fetch the first page itself. Coming back to the tab (after allowing access
 * in another one) re-reads the connections.
 */
export function useFirstRun({
  accountId,
  provided,
}: {
  accountId: string;
  /** The shelf's own list; undefined means «load the first page here». */
  provided?: { items: Artifact[]; loading: boolean };
}) {
  const [connections, setConnections] = useState<Loaded<AgentConnection[]>>({
    status: "loading",
    value: [],
  });
  const [ownWorks, setOwnWorks] = useState<Loaded<Artifact[]>>({
    status: "loading",
    value: [],
  });
  const generation = useRef(0);
  // Whether the caller supplies works is fixed for the lifetime of the hook.
  const selfLoads = useRef(provided === undefined).current;

  const loadConnections = useCallback(() => {
    const current = ++generation.current;
    setConnections((s) => ({ status: "loading", value: s.value }));
    client.agentConnections
      .list()
      .then((list) => {
        if (current === generation.current)
          setConnections({ status: "ready", value: list });
      })
      .catch((e: Error) => {
        if (current === generation.current)
          setConnections((s) => ({ status: "error", value: s.value, error: e.message }));
      });
  }, []);

  const loadWorks = useCallback(() => {
    if (!selfLoads) return;
    const current = generation.current;
    setOwnWorks((s) => ({ status: "loading", value: s.value }));
    client
      .shelf("", null)
      .then((page) => {
        if (current === generation.current)
          setOwnWorks({ status: "ready", value: page.items });
      })
      .catch((e: Error) => {
        if (current === generation.current)
          setOwnWorks((s) => ({ status: "error", value: s.value, error: e.message }));
      });
  }, [selfLoads]);

  useEffect(() => {
    loadConnections();
    loadWorks();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadConnections();
        loadWorks();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accountId, loadConnections, loadWorks]);

  const works: Loaded<Artifact[]> = provided
    ? { status: provided.loading ? "loading" : "ready", value: provided.items }
    : ownWorks;

  return {
    connections,
    works,
    reloadConnections: loadConnections,
    reloadWorks: loadWorks,
  };
}
