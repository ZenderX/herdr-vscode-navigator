import assert from "node:assert/strict";
import { PENDING_STALE_MS, reconcilePending as reconcilePendingOn, resumePending } from "../../../follow/pending";
import type { ResumeDeps } from "../../../follow/pending";

// Tests default to win32 explicitly so they run identically on any host.
const reconcilePending = (
  pending: unknown,
  open: readonly { path: string }[],
  now: number,
  platform: NodeJS.Platform = "win32",
) => reconcilePendingOn(pending, open, now, platform);

const folders = (...paths: string[]) => paths.map((path) => ({ path }));
const NOW = 1_000_000;

describe("reconcilePending", () => {
  it("clears an intent once its target is open, keeps a fresh unopened one for re-planning, and discards a stale one", () => {
    const outcome = (pending: unknown, open: readonly { path: string }[]) => {
      const { action, clear } = reconcilePending(pending, open, NOW);
      return [action, clear];
    };
    assert.deepEqual(outcome({ target: "C:\\Work\\", at: NOW - 1000 }, folders("C:\\anchor", "c:\\work")), ["reconciled", true]);
    assert.deepEqual(outcome({ target: "C:\\w", at: NOW - 1000 }, folders("C:\\anchor")), ["replan", false]);
    assert.deepEqual(outcome({ target: "C:\\anchor", at: NOW }, folders("C:\\anchor")), ["replan", false]);
    assert.deepEqual(outcome({ target: "C:\\w", at: NOW - PENDING_STALE_MS - 1 }, folders("C:\\anchor")), ["discard", true]);
  });
});

function resume(overrides: Partial<ResumeDeps>) {
  const calls: string[] = [];
  const deps: ResumeDeps = {
    pending: undefined,
    saved: undefined,
    folders: () => folders("C:\\anchor"),
    takeover: { record: { at: NOW }, savedNavigator: false, maxAgeMs: 120_000, updateFolders: async () => false },
    now: NOW,
    platform: "win32",
    setTrackedPath: (path) => calls.push(`track:${path}`),
    saveTracked: async (path) => void calls.push(`save:${path}`),
    adoptConfirmation: async () => void calls.push("adopt"),
    clearPending: async () => void calls.push("clear"),
    log: () => undefined,
    ...overrides,
  };
  return { calls, run: () => resumePending(deps) };
}

describe("resumePending", () => {
  it("tracks, saves and clears an open pending target, adopting the confirmation only when confirmed, else falls back to the saved slot", async () => {
    const open = folders("C:\\anchor", "C:\\w");
    const confirmed = resume({ pending: { target: "C:\\w", at: NOW, confirmed: true }, folders: () => open });
    await confirmed.run();
    assert.deepEqual(confirmed.calls, ["track:C:\\w", "save:C:\\w", "clear", "adopt"]);

    const unconfirmed = resume({ pending: { target: "C:\\w", at: NOW }, folders: () => open });
    await unconfirmed.run();
    assert.deepEqual(unconfirmed.calls, ["track:C:\\w", "save:C:\\w", "clear"]);

    const gone = resume({ pending: { target: "C:\\gone", at: NOW }, saved: "C:\\s", folders: () => folders("C:\\anchor", "C:\\s") });
    await gone.run();
    assert.deepEqual(gone.calls, ["track:C:\\s", "save:C:\\s"]);
  });
});
