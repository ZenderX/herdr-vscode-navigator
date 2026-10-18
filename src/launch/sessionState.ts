export interface SessionRecord {
  version: 1;
  herdrWasRunning: boolean;
  lastSpaceLabel?: string;
  lastFolder?: string;
  updatedAt: number;
}

export type HostingLostReason = "herdr-exited" | "terminal-closed-by-user" | "shutdown" | "unknown";

export type SessionEvent =
  | { type: "hostingSeen" }
  | { type: "hostingLost"; reason: HostingLostReason }
  | { type: "spaceFocused"; label: string; folder: string };

export function empty(): SessionRecord {
  return { version: 1, herdrWasRunning: false, updatedAt: 0 };
}

/** Reads a persisted value; anything missing or of another version is an empty record. */
export function readRecord(raw: unknown): SessionRecord {
  if (typeof raw !== "object" || raw === null) return empty();
  const { version, herdrWasRunning, lastSpaceLabel, lastFolder, updatedAt } = raw as Record<string, unknown>;
  if (version !== 1 || typeof herdrWasRunning !== "boolean" || typeof updatedAt !== "number") return empty();
  return {
    version: 1,
    herdrWasRunning,
    ...(typeof lastSpaceLabel === "string" ? { lastSpaceLabel } : {}),
    ...(typeof lastFolder === "string" ? { lastFolder } : {}),
    updatedAt,
  };
}

export function reduce(record: SessionRecord, event: SessionEvent, now: number): SessionRecord {
  switch (event.type) {
    case "hostingSeen":
      return { ...record, herdrWasRunning: true, updatedAt: now };
    case "hostingLost":
      // Terminals close on VS Code shutdown; that loss must not erase "herdr was running".
      if (event.reason === "shutdown" || event.reason === "unknown") return record;
      return { ...record, herdrWasRunning: false, updatedAt: now };
    case "spaceFocused":
      return { ...record, lastSpaceLabel: event.label, lastFolder: event.folder, updatedAt: now };
  }
}
