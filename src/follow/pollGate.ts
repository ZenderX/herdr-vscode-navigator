import type { HostState } from "../hosting";
import { mayFollowAutomatically } from "../hosting";

export interface PollGateInput {
  connected: boolean;
  autoFollow: boolean;
  host: HostState;
  confirmedHere: boolean | undefined;
  cwdPollMs: number;
}

/** The interval the cwd poller must run at, or 0 when it must be stopped. */
export function pollIntervalMs({ connected, autoFollow, host, confirmedHere, cwdPollMs }: PollGateInput): number {
  return connected && autoFollow && mayFollowAutomatically(host, confirmedHere) ? cwdPollMs : 0;
}

/** Holds the hosting state and reports each real change, so every writer refreshes what depends on it. */
export function createHostState(onChange: () => void): { get: () => HostState; set: (next: HostState) => void } {
  let state: HostState = "no";
  return {
    get: () => state,
    set: (next) => {
      if (next === state) return;
      state = next;
      onChange();
    },
  };
}
