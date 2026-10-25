import type { PaneEntry } from "./record";

export type ConnectionEvent =
  | { kind: "reconnected" }
  | {
      kind: "connected";
      /** Current herdr `shell_pid` by pane id; panes whose lookup failed are absent. */
      shellPids: ReadonlyMap<string, number>;
      recorded: Readonly<Record<string, PaneEntry>>;
    };

/**
 * A socket lost and back means the server restarted; a first connect counts only when a recorded pane's id now has
 * another shell pid: a restart respawns every pane under its old id. Entries without a folder or a pid never count,
 * and a reused id is caught later by the spawn check.
 */
export function isRestart(event: ConnectionEvent): boolean {
  if (event.kind === "reconnected") return true;
  const { shellPids, recorded } = event;
  return [...shellPids].some(([paneId, shellPid]) => {
    const entry: PaneEntry | undefined = recorded[paneId];
    return entry?.folder !== undefined && entry.shellPid !== undefined && entry.shellPid !== shellPid;
  });
}
