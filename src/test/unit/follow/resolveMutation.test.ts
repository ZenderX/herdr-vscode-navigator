import assert from "node:assert/strict";
import { planFolders } from "../../../follow/planFolders";
import type { FolderPlan } from "../../../follow/planFolders";
import { resolveMutation } from "../../../follow/resolveMutation";

const L = "c:\\storage\\old.herdr-navigator\\anchor";
const STALE = "c:\\worktrees\\stale";
const TRACKED = "c:\\projects\\Tracked";
const open = [L, STALE, TRACKED];

const mutate = (plan: FolderPlan, paths: readonly string[] = open) => {
  assert.notEqual(plan.kind, "noop");
  return resolveMutation(plan as Exclude<FolderPlan, { kind: "noop" }>, paths, "win32");
};

describe("resolveMutation", () => {
  for (const target of [TRACKED, STALE]) {
    it(`reclaim re-adds ${target} that is open inside the deleted range`, () => {
      const plan = planFolders({ folders: open.map((path) => ({ path })), trackedPath: TRACKED, anchorPath: L, target, isMultiRoot: true, adoptedAnchor: true, platform: "win32" });
      assert.deepEqual(mutate(plan), { start: 1, deleteCount: 2, add: [target] });
    });
  }

  it("skips a reclaim whose add path is the folder kept at index 0", () => {
    assert.equal(mutate({ kind: "reclaim", index: 1, deleteCount: 2, add: [L] }), null);
  });

  it("skips a replace whose target is open at another index", () => {
    assert.equal(mutate({ kind: "replace", index: 2, add: [STALE] }), null);
  });

  it("skips an append whose target is already open", () => {
    assert.equal(mutate({ kind: "append", index: 3, add: [STALE] }), null);
  });

  it("compares paths with the given platform rules", () => {
    const plan: FolderPlan = { kind: "append", index: 3, add: ["C:\\WORKTREES\\STALE"] };
    assert.equal(mutate(plan), null);
    assert.deepEqual(resolveMutation({ kind: "append", index: 3, add: ["/A"] }, ["/a"], "linux"), { start: 3, deleteCount: 0, add: ["/A"] });
  });

  it("passes convert and remove through", () => {
    assert.deepEqual(mutate({ kind: "convert", start: 0, deleteCount: 1, add: [L, STALE] }), { start: 0, deleteCount: 1, add: [L, STALE] });
    assert.deepEqual(mutate({ kind: "remove", index: 2 }), { start: 2, deleteCount: 1, add: [] });
  });
});
