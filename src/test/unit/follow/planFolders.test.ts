import assert from "node:assert/strict";
import { planFolders as planFoldersOn } from "../../../follow/planFolders";
import type { FolderPlan, PlanInput } from "../../../follow/planFolders";
import { resolveMutation } from "../../../follow/resolveMutation";

// Tests default to win32 explicitly so they run identically on any host.
const planFolders = (input: Omit<PlanInput, "platform"> & { platform?: NodeJS.Platform }): FolderPlan =>
  planFoldersOn({ platform: "win32", ...input });

const ANCHOR = "C:\\anchor";
const folders = (...paths: string[]) => paths.map((path) => ({ path }));

/** The folder list one updateWorkspaceFolders call leaves, since that call is all Git sees of a switch. */
const after = (plan: FolderPlan, open: readonly string[]): string[] => {
  if (plan.kind === "noop") return [...open];
  const mutation = resolveMutation(plan, open, "win32");
  assert.ok(mutation !== null, JSON.stringify({ plan, open }));
  const { start, deleteCount, add } = mutation;
  return [...open.slice(0, start), ...add, ...open.slice(start + deleteCount)];
};

describe("planFolders", () => {
  it("converts an empty, single-folder or anchor-only window to [anchor, target]", () => {
    const base = { trackedPath: null, anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: false };
    assert.deepEqual(planFolders({ ...base, folders: [] }), { kind: "convert", start: 0, deleteCount: 0, add: [ANCHOR, "C:\\t"] });
    assert.deepEqual(planFolders({ ...base, folders: folders("C:\\x") }), { kind: "convert", start: 0, deleteCount: 1, add: [ANCHOR, "C:\\t"] });
    assert.deepEqual(planFolders({ ...base, folders: folders(ANCHOR) }), { kind: "convert", start: 1, deleteCount: 0, add: ["C:\\t"] });
  });

  it("replaces the tracked slot in place, removes it for the anchor, and swaps out an untracked folder in one mutation so no second followed folder appears", () => {
    const base = { anchorPath: ANCHOR, isMultiRoot: true };
    const open = folders(ANCHOR, "C:\\old");
    assert.deepEqual(planFolders({ ...base, folders: open, trackedPath: "C:\\old", target: "C:\\new" }), { kind: "replace", index: 1, add: ["C:\\new"] });
    assert.deepEqual(planFolders({ ...base, folders: open, trackedPath: "C:\\old", target: ANCHOR }), { kind: "remove", index: 1, deleteCount: 1 });
    for (const trackedPath of [null, "C:\\gone"]) {
      const untracked = planFolders({ ...base, folders: open, trackedPath, target: "C:\\t" });
      assert.deepEqual(untracked, { kind: "reclaim", index: 1, deleteCount: 1, add: ["C:\\t"] });
      assert.deepEqual(after(untracked, [ANCHOR, "C:\\old"]), [ANCHOR, "C:\\t"]);
    }
    assert.deepEqual(planFolders({ ...base, folders: folders(ANCHOR, "C:\\t"), trackedPath: null, target: "C:\\t" }), { kind: "noop", reason: "target already open" });
    // A folder the user added stays while focus stays in the space, and goes at the next switch.
    const added = folders(ANCHOR, "C:\\t", "C:\\added");
    assert.deepEqual(planFolders({ ...base, folders: added, trackedPath: "C:\\t", target: "C:\\t" }), { kind: "noop", reason: "target already in tracked slot" });
    assert.deepEqual(planFolders({ ...base, folders: added, trackedPath: "C:\\t", target: "C:\\new" }), { kind: "reclaim", index: 1, deleteCount: 2, add: ["C:\\new"] });
    // A followed folder stranded behind a stale slot takes slot 1, since slot 1 is what the window treats as followed.
    assert.deepEqual(planFolders({ ...base, folders: folders(ANCHOR, "C:\\stale", "C:\\t"), trackedPath: "C:\\t", target: "C:\\t" }), { kind: "reclaim", index: 1, deleteCount: 2, add: ["C:\\t"] });
    // Slot 1 is empty after a remove, so only here does an anchor window append.
    assert.deepEqual(planFolders({ ...base, folders: folders(ANCHOR), trackedPath: null, target: "C:\\t" }), { kind: "append", index: 1, add: ["C:\\t"] });
    // A multi-root window of the user's own is not a navigator: following must never delete their folders.
    const own = folders("C:\\mine", "C:\\yours");
    assert.deepEqual(planFolders({ ...base, folders: own, trackedPath: null, target: "C:\\t" }), { kind: "append", index: 2, add: ["C:\\t"] });
    // A worktree slot opened under its basename must be renamed in place to the project name, and only when the name differs.
    const worktree = "C:\\mainproj\\develop";
    const slot = { ...base, folders: [{ path: ANCHOR }, { path: worktree, name: "develop" }], trackedPath: worktree, target: worktree };
    assert.deepEqual(planFolders({ ...slot, targetName: "mainproj" }), { kind: "replace", index: 1, add: [worktree], name: "mainproj" });
    assert.deepEqual(planFolders({ ...slot, targetName: "develop" }), { kind: "noop", reason: "target already in tracked slot" });
    assert.deepEqual(planFolders(slot), { kind: "noop", reason: "target already in tracked slot" });
    assert.deepEqual(planFolders({ ...base, folders: open, trackedPath: "C:\\old", target: worktree, targetName: "mainproj" }), {
      kind: "replace",
      index: 1,
      add: [worktree],
      name: "mainproj",
    });
  });

  it("never touches index 0 once two or more folders are open, and a switch always leaves the anchor plus only the target", () => {
    const sets = [
      folders("C:\\a", "C:\\b"),
      folders("C:\\a", "C:\\b", "C:\\c"),
      folders("C:\\a", "C:\\t"),
      folders("C:\\a", "C:\\b", "C:\\c", "C:\\d"),
    ];
    const trackedOptions = [null, "C:\\a", "C:\\b", "C:\\c", "C:\\gone"];
    const targets = ["C:\\a", "C:\\b", "C:\\c", "C:\\t", "C:\\new"];
    let checked = 0;
    for (const set of sets) {
      for (const trackedPath of trackedOptions) {
        for (const target of targets) {
          for (const targetName of [undefined, "mainproj"]) {
            const plan: FolderPlan = planFolders({ folders: set, trackedPath, anchorPath: "C:\\a", target, targetName, isMultiRoot: true });
            assert.notEqual(plan.kind, "convert", JSON.stringify({ set, trackedPath, target, targetName }));
            if ("index" in plan) assert.ok(plan.index >= 1, JSON.stringify({ set, trackedPath, target, targetName, plan }));
            const left = after(plan, set.map(({ path }) => path));
            const context = JSON.stringify({ set, trackedPath, target, targetName, plan });
            // Target already in slot 1 with more folders open is no switch, so only slot 1 is pinned.
            if (set.length > 2 && set[1].path === target) assert.equal(left[1], target, context);
            else assert.deepEqual(left, target === "C:\\a" ? ["C:\\a"] : ["C:\\a", target], context);
            checked += 1;
          }
        }
      }
    }
    assert.equal(checked, 200);
  });

  it("treats a target that differs only in path form as already open, with case mattering on linux but not on win32 or darwin", () => {
    for (const target of ["c:\\user", "C:\\user\\", "c:/USER/", "/c/user"]) {
      const plan = planFolders({ folders: folders(ANCHOR, "C:\\user"), trackedPath: null, anchorPath: ANCHOR, target, isMultiRoot: true });
      assert.equal(plan.kind, "noop", target);
    }
    const posix = { anchorPath: "/home/u/proj", isMultiRoot: true, folders: folders("/home/u/proj", "/home/u/x"), trackedPath: "/home/u/x" } as const;
    assert.equal(planFolders({ ...posix, target: "/home/u/a/../x/", platform: "linux" }).kind, "noop");
    assert.equal(planFolders({ ...posix, target: "/home/u/X", platform: "linux" }).kind, "replace");
    assert.equal(planFolders({ ...posix, target: "/home/u/X", platform: "darwin" }).kind, "noop");
    const named = { ...posix, folders: [{ path: "/home/u/proj" }, { path: "/home/u/x", name: "x" }], platform: "linux" } as const;
    assert.deepEqual(planFolders({ ...named, target: "/home/u/x/", targetName: "mainproj" }), { kind: "replace", index: 1, add: ["/home/u/x/"], name: "mainproj" });
    assert.equal(planFolders({ ...named, target: "/home/u/x/", targetName: "x" }).kind, "noop");
    assert.deepEqual(planFolders({ ...named, trackedPath: "/home/u/gone", target: "/home/u/y", targetName: "mainproj" }), {
      kind: "reclaim",
      index: 1,
      deleteCount: 1,
      add: ["/home/u/y"],
      name: "mainproj",
    });
  });

  it("reclaims index 1 and drops stale folders after an adopted legacy anchor without touching index 0", () => {
    const legacy = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\old.herdr-navigator\\anchor";
    const stale = "C:\\Users\\me\\worktrees\\stale-feature";
    const tracked = "C:\\Users\\me\\projects\\app";
    const base = { anchorPath: legacy, isMultiRoot: true, folders: folders(legacy, stale, tracked), trackedPath: tracked, target: "C:\\t" } as const;
    assert.deepEqual(planFolders({ ...base, adoptedAnchor: true }), { kind: "reclaim", index: 1, deleteCount: 2, add: ["C:\\t"] });
    assert.deepEqual(planFolders({ ...base, adoptedAnchor: false }), { kind: "reclaim", index: 1, deleteCount: 2, add: ["C:\\t"] });
    // Only the adoption keeps the old install's folders when the anchor itself is the target.
    assert.deepEqual(planFolders({ ...base, adoptedAnchor: true, target: legacy }), { kind: "noop", reason: "target is the adopted anchor" });
    assert.deepEqual(planFolders({ ...base, adoptedAnchor: false, target: legacy }), { kind: "remove", index: 1, deleteCount: 2 });
    // The user's own window keeps its folders and its tracked slot's index.
    assert.deepEqual(planFolders({ ...base, adoptedAnchor: false, anchorPath: ANCHOR }), { kind: "replace", index: 2, add: ["C:\\t"] });
  });
});
