import assert from "node:assert/strict";
import { PENDING_STALE_MS, reconcilePending as reconcilePendingOn, resumePending } from "../../../follow/pending";
import type { ResumeDeps } from "../../../follow/pending";
import type { FolderLike } from "../../../follow/planFolders";

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
    displayName: async () => undefined,
    setTrackedPath: (path, name) => calls.push(`track:${path}${name === undefined ? "" : ` as ${name}`}`),
    saveTracked: async (path) => void calls.push(`save:${path}`),
    adoptConfirmation: async () => void calls.push("adopt"),
    clearPending: async () => void calls.push("clear"),
    log: () => undefined,
    ...overrides,
  };
  return { calls, run: () => resumePending(deps) };
}

describe("resumePending", () => {
  it("tracks, saves and clears an open pending target, adopting the confirmation only when confirmed, else falls back to the saved slot, naming a worktree slot after its project", async () => {
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

    // A takeover and a converted window both label slot 1 with the derived project name, never the worktree basename.
    const tree = "C:\\mainproj\\develop";
    const displayName = async (folder: string) => (folder === tree ? "mainproj" : undefined);
    const updates: string[] = [];
    let slots: FolderLike[] = folders("C:\\anchor", "C:\\old");
    const updateFolders: ResumeDeps["takeover"]["updateFolders"] = async (kind, start, deleteCount, add) => {
      updates.push(`${kind} ${start} ${deleteCount} ${add.map(({ path, name }) => `${path} as ${String(name)}`).join(",")}`);
      slots = [...slots.slice(0, start), ...add, ...slots.slice(start + deleteCount)];
      return true;
    };
    const takeover = resume({
      folders: () => slots,
      displayName,
      takeover: { record: { folder: tree, at: NOW }, savedNavigator: true, maxAgeMs: 120_000, updateFolders },
    });
    await takeover.run();
    assert.deepEqual(updates, [`replace 1 1 ${tree} as mainproj`]);
    assert.deepEqual(takeover.calls, [`track:${tree} as mainproj`, `save:${tree}`]);

    updates.length = 0;
    slots = [{ path: "C:\\anchor" }, { path: tree, name: "develop" }];
    const converted = resume({
      pending: { target: tree, at: NOW },
      folders: () => slots,
      displayName,
      takeover: { record: { at: NOW }, savedNavigator: false, maxAgeMs: 120_000, updateFolders },
    });
    await converted.run();
    assert.deepEqual(updates, [`rename 1 1 ${tree} as mainproj`]);
    assert.deepEqual(converted.calls, [`track:${tree} as mainproj`, `save:${tree}`, "clear"]);
  });
});
