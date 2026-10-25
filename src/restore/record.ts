import { normalizeCwd, samePath } from "../paths";

/** One pane's recorded folders: `folder` is its last live folder, `spawn` the folder its shell was spawned in. */
export interface PaneEntry {
  folder?: string;
  /** Second key beside the pane id: a reused id with another spawn folder is a different pane. */
  spawn?: string;
  /** herdr's `shell_pid` when last seen: a restart respawns every pane under its old id with a new pid. */
  shellPid?: number;
}

/** Pane folders of one herdr session, keyed by public pane id (`wN:pN`, persisted and restored as-is). */
export interface CwdRecord {
  version: 2;
  key: string;
  panes: Record<string, PaneEntry>;
}

export interface PaneReading {
  paneId: string;
  rawCwd: string | null | undefined;
}

export interface MergeResult {
  record: CwdRecord;
  changed: boolean;
}

/** Herdr events the recorder folds in; none of them is a focus change. */
export const RECORD_EVENTS: ReadonlySet<string> = new Set([
  "pane_updated",
  "pane_created",
  "pane_moved",
  "pane_closed",
  "pane_exited",
  "tab_closed",
  "workspace_closed",
]);

/** Focus changes the recorder also folds in, with a full snapshot: the pane left behind may have changed folder unseen. */
export const FOCUS_EVENTS: ReadonlySet<string> = new Set(["workspace_focused", "tab_focused", "pane_focused"]);

/** File-name-safe key for the session behind `pipeName`. */
export function recordKey(pipeName: string): string {
  return pipeName.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function emptyRecord(key: string): CwdRecord {
  return { version: 2, key, panes: {} };
}

function isPaneEntry(value: unknown): value is PaneEntry {
  if (typeof value !== "object" || value === null) return false;
  if ("folder" in value && typeof value.folder !== "string") return false;
  if ("shellPid" in value && typeof value.shellPid !== "number") return false;
  return !("spawn" in value) || typeof value.spawn === "string";
}

/** A version-2 record, or a version-1 one (folder strings) lifted to version 2; anything else is undefined. */
export function parseRecord(value: unknown): CwdRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("key" in value) || typeof value.key !== "string") return undefined;
  if (!("panes" in value) || typeof value.panes !== "object" || value.panes === null) return undefined;
  const entries = Object.entries(value.panes);
  const version = "version" in value ? value.version : undefined;
  if (version === 1) {
    const folders = entries.filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (folders.length !== entries.length) return undefined;
    return { version: 2, key: value.key, panes: Object.fromEntries(folders.map(([paneId, folder]) => [paneId, { folder }])) };
  }
  const panes = entries.filter((entry): entry is [string, PaneEntry] => isPaneEntry(entry[1]));
  if (version !== 2 || panes.length !== entries.length) return undefined;
  return { version: 2, key: value.key, panes: Object.fromEntries(panes) };
}

// Spawn form keeps a trailing separator until the shell reports its folder (PowerShell at its first prompt); Git Bash never does.
export function isSpawnForm(rawCwd: string | null | undefined): boolean {
  if (typeof rawCwd !== "string" || rawCwd.length <= 3) return false;
  return rawCwd.endsWith("\\") || rawCwd.endsWith("/");
}

/**
 * A live reading sets the folder; a spawn-form reading sets the spawn folder and keeps the folder, unless the
 * stored spawn folder differs: then the id was reused by another pane and its stale folder is dropped.
 */
function applyReading(entry: PaneEntry | undefined, rawCwd: string | null | undefined, platform: NodeJS.Platform): PaneEntry | undefined {
  const normalized = normalizeCwd(rawCwd, platform);
  if (normalized === null) return entry;
  if (!isSpawnForm(rawCwd)) return { ...entry, folder: normalized };
  if (entry?.spawn !== undefined && !samePath(entry.spawn, normalized, platform)) return { spawn: normalized };
  return { ...entry, spawn: normalized };
}

function sameEntry(a: PaneEntry | undefined, b: PaneEntry | undefined): boolean {
  return a?.folder === b?.folder && a?.spawn === b?.spawn && a?.shellPid === b?.shellPid;
}

function result(record: CwdRecord, panes: Record<string, PaneEntry>): MergeResult {
  const before = Object.entries(record.panes);
  const changed = before.length !== Object.keys(panes).length || before.some(([paneId, entry]) => !sameEntry(panes[paneId], entry));
  return { record: { version: 2, key: record.key, panes }, changed };
}

/** Folds one pane's reading into the record; other panes are untouched. */
export function mergePane(record: CwdRecord, { paneId, rawCwd }: PaneReading, platform: NodeJS.Platform): MergeResult {
  const panes = { ...record.panes };
  const entry = applyReading(panes[paneId], rawCwd, platform);
  if (entry === undefined) return { record, changed: false };
  panes[paneId] = entry;
  return result(record, panes);
}

export function dropPanes(record: CwdRecord, paneIds: readonly string[]): MergeResult {
  const panes = Object.fromEntries(Object.entries(record.panes).filter(([paneId]) => !paneIds.includes(paneId)));
  return result(record, panes);
}

/** Folds a full snapshot in: readings apply in order as in mergePane, and panes without a reading are dropped. */
export function mergeRecord(record: CwdRecord, readings: readonly PaneReading[], platform: NodeJS.Platform): MergeResult {
  const panes: Record<string, PaneEntry> = {};
  for (const { paneId, rawCwd } of readings) {
    const entry = applyReading(panes[paneId] ?? record.panes[paneId], rawCwd, platform);
    if (entry !== undefined) panes[paneId] = entry;
  }
  return result(record, panes);
}

/** Sets the spawn folder of recorded panes from process-info cwds; unlike a spawn-form reading it never resets the folder. */
export function setSpawns(record: CwdRecord, readings: readonly PaneReading[], platform: NodeJS.Platform): MergeResult {
  const panes = { ...record.panes };
  for (const { paneId, rawCwd } of readings) {
    const entry = panes[paneId];
    const spawn = normalizeCwd(rawCwd, platform);
    if (entry !== undefined && spawn !== null) panes[paneId] = { ...entry, spawn };
  }
  return result(record, panes);
}

/** Stores the current shell pid of recorded panes. */
export function setShellPids(record: CwdRecord, pids: ReadonlyMap<string, number>): MergeResult {
  const panes = { ...record.panes };
  for (const [paneId, shellPid] of pids) {
    const entry = panes[paneId];
    if (entry !== undefined) panes[paneId] = { ...entry, shellPid };
  }
  return result(record, panes);
}

/** Recorded live folders by pane id; panes known only by their spawn folder have nothing to return to. */
export function recordedFolders(record: CwdRecord): Record<string, string> {
  return Object.fromEntries(Object.entries(record.panes).flatMap(([paneId, { folder }]) => (folder === undefined ? [] : [[paneId, folder]])));
}
