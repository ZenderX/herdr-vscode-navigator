import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface NavigatorLease {
  launchId: string;
  writtenAt: number;
  folder: string;
}

/** A lease older than this is ignored even when its launch matches: its writer stopped refreshing it. */
export const LEASE_STALE_MS = 60_000;

/** Time a plain-folder window waits for a restored navigator window to write its lease. */
export const TAKEOVER_GRACE_MS = 3_000;

/** Parses a lease; one written with the old per-window `sessionId` gets a launch id that no launch matches. */
export function parseLease(value: unknown): NavigatorLease | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { launchId, sessionId, writtenAt, folder } = value as Record<string, unknown>;
  if (typeof writtenAt !== "number" || typeof folder !== "string") return undefined;
  if (typeof launchId === "string") return { launchId, writtenAt, folder };
  if (typeof sessionId === "string") return { launchId: `legacy-session:${sessionId}`, writtenAt, folder };
  return undefined;
}

/** Reads a lease file; a missing, unreadable, or malformed file is no lease. */
export function readLease(filePath: string): NavigatorLease | undefined {
  try {
    return parseLease(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

/** Writes via temp file and rename so other windows never read a half-written lease. */
export function writeLease(filePath: string, lease: NavigatorLease): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(lease), "utf8");
  renameSync(temp, filePath);
}

export function isLeaseLive(lease: NavigatorLease | undefined, launchId: string, now: number): boolean {
  if (lease === undefined) return false;
  return lease.launchId === launchId && now - lease.writtenAt <= LEASE_STALE_MS;
}
