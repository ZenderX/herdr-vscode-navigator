import assert from "node:assert/strict";
import { planFolders as planFoldersOn } from "../../../follow/planFolders";
import type { FolderPlan, PlanInput } from "../../../follow/planFolders";

// Tests default to win32 explicitly so they run identically on any host.
const planFolders = (input: Omit<PlanInput, "platform"> & { platform?: NodeJS.Platform }): FolderPlan =>
  planFoldersOn({ platform: "win32", ...input });

const ANCHOR = "C:\\anchor";
const folders = (...paths: string[]) => paths.map((path) => ({ path }));

describe("planFolders", () => {
  it("converts an empty window by adding anchor and target", () => {
    const plan = planFolders({ folders: [], trackedPath: null, anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: false });
    assert.deepEqual(plan, { kind: "convert", start: 0, deleteCount: 0, add: [ANCHOR, "C:\\t"] });
  });

  it("empty window with target equal to anchor adds the anchor once", () => {
    const plan = planFolders({ folders: [], trackedPath: null, anchorPath: ANCHOR, target: "c:\\ANCHOR", isMultiRoot: false });
    assert.deepEqual(plan, { kind: "convert", start: 0, deleteCount: 0, add: [ANCHOR] });
  });

  it("rejects an empty anchor for an empty window", () => {
    assert.throws(() => planFolders({ folders: [], trackedPath: null, anchorPath: "", target: "C:\\t", isMultiRoot: false }));
  });

  it("converts a single user-folder window to [anchor, target], dropping the user folder", () => {
    const plan = planFolders({ folders: folders("C:\\x"), trackedPath: null, anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: false });
    assert.deepEqual(plan, { kind: "convert", start: 0, deleteCount: 1, add: [ANCHOR, "C:\\t"] });
  });

  it("leaves a single-folder window alone when the target is that folder", () => {
    const plan = planFolders({ folders: folders("C:\\x"), trackedPath: null, anchorPath: ANCHOR, target: "c:\\X", isMultiRoot: false });
    assert.equal(plan.kind, "noop");
  });

  it("converts a single-anchor window by adding the target after the anchor", () => {
    const plan = planFolders({ folders: folders(ANCHOR), trackedPath: null, anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: false });
    assert.deepEqual(plan, { kind: "convert", start: 1, deleteCount: 0, add: ["C:\\t"] });
  });

  it("appends to a one-folder multi-root workspace without converting", () => {
    const plan = planFolders({ folders: folders(ANCHOR), trackedPath: null, anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: true });
    assert.deepEqual(plan, { kind: "append", index: 1, add: ["C:\\t"] });
  });

  it("replaces the tracked slot at index 1 in place", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\old"), trackedPath: "C:\\old", anchorPath: ANCHOR, target: "C:\\new", isMultiRoot: true });
    assert.deepEqual(plan, { kind: "replace", index: 1, add: ["C:\\new"] });
  });

  it("noops when the target is already the tracked slot", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\Old"), trackedPath: "c:\\old", anchorPath: ANCHOR, target: "C:\\old", isMultiRoot: true });
    assert.equal(plan.kind, "noop");
  });

  it("noops when the target equals the anchor and nothing is tracked", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\user"), trackedPath: null, anchorPath: ANCHOR, target: ANCHOR, isMultiRoot: true });
    assert.equal(plan.kind, "noop");
  });

  it("removes the tracked slot when the target equals the anchor", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\old"), trackedPath: "C:\\old", anchorPath: ANCHOR, target: ANCHOR, isMultiRoot: true });
    assert.deepEqual(plan, { kind: "remove", index: 1 });
  });

  it("appends when the tracked path is no longer open", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\user"), trackedPath: "C:\\gone", anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: true });
    assert.deepEqual(plan, { kind: "append", index: 2, add: ["C:\\t"] });
  });

  it("never treats a tracked slot at index 0 as replaceable", () => {
    const plan = planFolders({ folders: folders("C:\\a", "C:\\b"), trackedPath: "C:\\a", anchorPath: ANCHOR, target: "C:\\t", isMultiRoot: true });
    assert.deepEqual(plan, { kind: "append", index: 2, add: ["C:\\t"] });
  });

  it("never touches index 0 once two or more folders are open", () => {
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
          const plan: FolderPlan = planFolders({ folders: set, trackedPath, anchorPath: "C:\\a", target, isMultiRoot: true });
          assert.notEqual(plan.kind, "convert", JSON.stringify({ set, trackedPath, target }));
          if ("index" in plan) assert.ok(plan.index >= 1, JSON.stringify({ set, trackedPath, target, plan }));
          checked += 1;
        }
      }
    }
    assert.equal(checked, 100);
  });

  it("noops for a target differing only in drive-letter case or trailing slash", () => {
    for (const target of ["c:\\user", "C:\\user\\", "c:/USER/", "/c/user"]) {
      const plan = planFolders({ folders: folders(ANCHOR, "C:\\user"), trackedPath: null, anchorPath: ANCHOR, target, isMultiRoot: true });
      assert.equal(plan.kind, "noop", target);
    }
  });

  it("noops for an anchor target differing only in case or trailing slash", () => {
    const plan = planFolders({ folders: folders(ANCHOR), trackedPath: null, anchorPath: ANCHOR, target: "c:\\Anchor\\", isMultiRoot: false });
    assert.equal(plan.kind, "noop");
  });

  describe("POSIX paths", () => {
    const base = { anchorPath: "/home/u/proj", isMultiRoot: true, platform: "linux" } as const;
    const open = folders("/home/u/proj", "/home/u/x");

    it("noops for a target equal to the tracked slot, with or without a trailing slash", () => {
      for (const target of ["/home/u/x", "/home/u/x/", "/home/u/a/../x"]) {
        assert.equal(planFolders({ ...base, folders: open, trackedPath: "/home/u/x", target }).kind, "noop", target);
      }
    });

    it("noops for a target equal to the anchor when nothing is tracked", () => {
      assert.equal(planFolders({ ...base, folders: open, trackedPath: null, target: "/home/u/proj/" }).kind, "noop");
    });

    it("replaces the tracked index when the POSIX target changes", () => {
      const plan = planFolders({ ...base, folders: open, trackedPath: "/home/u/x", target: "/home/u/y" });
      assert.deepEqual(plan, { kind: "replace", index: 1, add: ["/home/u/y"] });
    });

    it("treats paths differing only in case as different on linux but equal on darwin", () => {
      const input = { ...base, folders: open, trackedPath: "/home/u/x", target: "/home/u/X" };
      assert.equal(planFolders(input).kind, "replace");
      assert.equal(planFolders({ ...input, platform: "darwin" }).kind, "noop");
    });
  });

  it("emits exactly one folder in each add list", () => {
    const plan = planFolders({ folders: folders(ANCHOR, "C:\\old"), trackedPath: "C:\\old", anchorPath: ANCHOR, target: "C:\\new", isMultiRoot: true });
    assert.ok(plan.kind === "replace" && plan.add.length === 1);
  });
});
