export interface SessionRecord {
  version: 1;
  herdrWasRunning: boolean;
  lastSpaceLabel?: string;
  lastFolder?: string;
  /** Launch id of the VS Code launch in which the navigator last ran; a record with only the old per-window `sessionId` has none, so it matches no launch. */
  launchId?: string;
  /** Folder a plain window is converting for; the converted navigator launches herdr there once. */
  pendingTakeoverFolder?: string;
  updatedAt: number;
}

export type HostingLostReason = "herdr-exited" | "terminal-closed-by-user" | "shutdown" | "unknown";

export type SessionEvent =
  | { type: "hostingSeen"; launchId?: string }
  | { type: "hostingLost"; reason: HostingLostReason }
  | { type: "spaceFocused"; label: string; folder: string }
  | { type: "takeoverPending"; folder: string }
  | { type: "takeoverConsumed" };

export function empty(): SessionRecord {
  return { version: 1, herdrWasRunning: false, updatedAt: 0 };
}

/** Reads a persisted value; anything missing or of another version is an empty record. */
export function readRecord(raw: unknown): SessionRecord {
  if (typeof raw !== "object" || raw === null) return empty();
  const { version, herdrWasRunning, lastSpaceLabel, lastFolder, launchId, pendingTakeoverFolder, updatedAt } =
    raw as Record<string, unknown>;
  if (version !== 1 || typeof herdrWasRunning !== "boolean" || typeof updatedAt !== "number") return empty();
  return {
    version: 1,
    herdrWasRunning,
    ...(typeof lastSpaceLabel === "string" ? { lastSpaceLabel } : {}),
    ...(typeof lastFolder === "string" ? { lastFolder } : {}),
    ...(typeof launchId === "string" ? { launchId } : {}),
    ...(typeof pendingTakeoverFolder === "string" ? { pendingTakeoverFolder } : {}),
    updatedAt,
  };
}

export function reduce(record: SessionRecord, event: SessionEvent, now: number): SessionRecord {
  switch (event.type) {
    case "hostingSeen":
      return {
        ...record,
        herdrWasRunning: true,
        ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
        updatedAt: now,
      };
    case "hostingLost":
      // Terminals close on VS Code shutdown; that loss must not erase "herdr was running".
      if (event.reason === "shutdown" || event.reason === "unknown") return record;
      return { ...record, herdrWasRunning: false, updatedAt: now };
    case "spaceFocused":
      return { ...record, lastSpaceLabel: event.label, lastFolder: event.folder, updatedAt: now };
    case "takeoverPending":
      return { ...record, pendingTakeoverFolder: event.folder, updatedAt: now };
    case "takeoverConsumed": {
      const { pendingTakeoverFolder: _consumed, ...rest } = record;
      return { ...rest, updatedAt: now };
    }
  }
}
