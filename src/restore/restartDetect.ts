import { isSpawnForm } from "./record";

export type ConnectionEvent =
  | { kind: "reconnected" }
  | {
      kind: "connected";
      panes: readonly { paneId: string; rawCwd: string | null | undefined }[];
      recordedPaneIds: ReadonlySet<string>;
    };

/**
 * A socket lost and back means the server restarted; a first connect counts only when a recorded pane is in
 * spawn form: it once reported a live folder, so spawn form now means it was just respawned. Unrecorded panes
 * never count, since shells without OSC 7 stay in spawn form forever. Missed when every recorded pane drew its
 * first prompt before this snapshot: that is indistinguishable from the user changing folder.
 */
export function isRestart(event: ConnectionEvent): boolean {
  if (event.kind === "reconnected") return true;
  const { panes, recordedPaneIds } = event;
  return panes.some(({ paneId, rawCwd }) => recordedPaneIds.has(paneId) && isSpawnForm(rawCwd));
}
