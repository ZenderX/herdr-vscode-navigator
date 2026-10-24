import { normalizeCwd } from "../paths";

/** Live pane folders of one herdr session, keyed by public pane id (`wN:pN`, stable across restores). */
export interface CwdRecord {
  version: 1;
  key: string;
  panes: Record<string, string>;
}

export interface PaneReading {
  paneId: string;
  rawCwd: string | null | undefined;
}

export interface MergeResult {
  record: CwdRecord;
  changed: boolean;
}

/** File-name-safe key for the session behind `pipeName`. */
export function recordKey(pipeName: string): string {
  return pipeName.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function emptyRecord(key: string): CwdRecord {
  return { version: 1, key, panes: {} };
}

export function isCwdRecord(value: unknown): value is CwdRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || value.version !== 1) return false;
  if (!("key" in value) || typeof value.key !== "string") return false;
  if (!("panes" in value) || typeof value.panes !== "object" || value.panes === null) return false;
  return Object.values(value.panes).every((folder) => typeof folder === "string");
}

// Spawn form keeps a trailing separator until the shell's first prompt reports its folder through OSC 7.
export function isSpawnForm(rawCwd: string | null | undefined): boolean {
  if (typeof rawCwd !== "string" || rawCwd.length <= 3) return false;
  return rawCwd.endsWith("\\") || rawCwd.endsWith("/");
}

/**
 * Folds one snapshot into the record: live readings replace entries, spawn-form readings keep the recorded
 * folder, and panes missing from the snapshot or without a usable cwd are dropped.
 */
export function mergeRecord(
  record: CwdRecord,
  readings: readonly PaneReading[],
  platform: NodeJS.Platform,
): MergeResult {
  const panes: Record<string, string> = {};
  for (const { paneId, rawCwd } of readings) {
    const recorded = record.panes[paneId];
    if (isSpawnForm(rawCwd)) {
      if (recorded !== undefined) panes[paneId] = recorded;
      continue;
    }
    const folder = normalizeCwd(rawCwd, platform);
    if (folder !== null) panes[paneId] = folder;
  }

  const before = Object.entries(record.panes);
  const changed =
    before.length !== Object.keys(panes).length || before.some(([paneId, folder]) => panes[paneId] !== folder);
  return { record: { version: 1, key: record.key, panes }, changed };
}
