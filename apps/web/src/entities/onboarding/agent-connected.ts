/**
 * «Разрешить» on /oauth/consent tells the shelf's other tabs at once that an
 * agent is being connected (docs/specs/ONBOARDING_V2.md): the shelf re-reads
 * its connections instead of waiting for the next poll. Same origin only; a
 * browser without BroadcastChannel keeps the poll.
 */
export const AGENT_CONNECTED_CHANNEL = "polka:agent-connected";

type Message = { type: "connected" };

export function announceAgentConnected() {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(AGENT_CONNECTED_CHANNEL);
    channel.postMessage({ type: "connected" } satisfies Message);
    channel.close();
  } catch {
    // A hint only: the shelf's poll finds the connection anyway.
  }
}

/** Calls `listener` when another tab announces a connection; returns the unsubscribe. */
export function onAgentConnected(listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(AGENT_CONNECTED_CHANNEL);
  } catch {
    return () => {};
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if ((event.data as Message | null)?.type === "connected") listener();
  };
  return () => channel.close();
}
