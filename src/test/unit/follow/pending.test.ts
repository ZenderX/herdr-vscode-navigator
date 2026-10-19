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
  it("reconciles and clears an intent whose target is already open (case and slash differences ignored)", () => {
    const outcome = reconcilePending({ target: "C:\\Work\\", at: NOW - 1000 }, folders("C:\\anchor", "c:\\work"), NOW);
    assert.equal(outcome.action, "reconciled");
    assert.equal(outcome.clear, true);
  });

  it("reconciles a POSIX intent", () => {
    const outcome = reconcilePending({ target: "/home/u/x/", at: NOW }, folders("/home/u/anchor", "/home/u/x"), NOW, "linux");
    assert.deepEqual([outcome.action, outcome.clear], ["reconciled", true]);
    const other = reconcilePending({ target: "/home/u/X", at: NOW }, folders("/home/u/anchor", "/home/u/x"), NOW, "linux");
    assert.equal(other.action, "replan");
  });

  it("does not count the anchor at index 0 as a reconciled target", () => {
    const outcome = reconcilePending({ target: "C:\\anchor", at: NOW }, folders("C:\\anchor"), NOW);
    assert.equal(outcome.action, "replan");
    assert.equal(outcome.clear, false);
  });

  it("keeps a fresh intent whose target is not open so the next cycle re-plans it", () => {
    const outcome = reconcilePending({ target: "C:\\w", at: NOW - 1000 }, folders("C:\\anchor"), NOW);
    assert.deepEqual([outcome.action, outcome.clear], ["replan", false]);
  });

  it("clears a stale intent", () => {
    const outcome = reconcilePending({ target: "C:\\w", at: NOW - PENDING_STALE_MS - 1 }, folders("C:\\anchor"), NOW);
    assert.deepEqual([outcome.action, outcome.clear], ["discard", true]);
  });

  it("clears a malformed intent and ignores a missing one", () => {
    assert.deepEqual(reconcilePending({ target: 1 }, [], NOW).clear, true);
    assert.deepEqual(reconcilePending(undefined, [], NOW), { action: "none", clear: false, message: "no pending intent" });
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
  it("tracks, saves and clears an open pending target, adopting the confirmation only when confirmed", async () => {
    const open = folders("C:\\anchor", "C:\\w");
    const confirmed = resume({ pending: { target: "C:\\w", at: NOW, confirmed: true }, folders: () => open });
    await confirmed.run();
    assert.deepEqual(confirmed.calls, ["track:C:\\w", "save:C:\\w", "clear", "adopt"]);

    const unconfirmed = resume({ pending: { target: "C:\\w", at: NOW }, folders: () => open });
    await unconfirmed.run();
    assert.deepEqual(unconfirmed.calls, ["track:C:\\w", "save:C:\\w", "clear"]);
  });

  it("uses the saved slot when the pending target is not open", async () => {
    const { calls, run } = resume({
      pending: { target: "C:\\gone", at: NOW },
      saved: "C:\\s",
      folders: () => folders("C:\\anchor", "C:\\s"),
    });
    await run();
    assert.deepEqual(calls, ["track:C:\\s", "save:C:\\s"]);
  });

  it("moves a fresh takeover folder into slot 1 of a saved navigator and tracks it", async () => {
    let open = folders("C:\\anchor", "C:\\old");
    const { calls, run } = resume({
      folders: () => open,
      saved: "C:\\old",
      takeover: {
        record: { folder: "C:\\t", at: NOW },
        savedNavigator: true,
        maxAgeMs: 120_000,
        updateFolders: async (_kind, _start, _deleteCount, add) => {
          open = folders("C:\\anchor", ...add);
          return true;
        },
      },
    });
    await run();
    assert.deepEqual(calls, ["track:C:\\t", "save:C:\\t"]);
  });

  it("clears a stale or malformed intent", async () => {
    const stale = resume({ pending: { target: "C:\\w", at: NOW - PENDING_STALE_MS - 1 } });
    await stale.run();
    assert.deepEqual(stale.calls, ["clear"]);

    const malformed = resume({ pending: { target: 1 } });
    await malformed.run();
    assert.deepEqual(malformed.calls, ["clear"]);
  });

  it("keeps a fresh unopened intent", async () => {
    const { calls, run } = resume({ pending: { target: "C:\\w", at: NOW - 1000, confirmed: true } });
    await run();
    assert.deepEqual(calls, []);
  });
});
