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
  it("re-adds a reclaim target open inside the deleted range, and skips a change whose target is already open elsewhere", () => {
    const plan = planFolders({ folders: open.map((path) => ({ path })), trackedPath: TRACKED, anchorPath: L, target: STALE, isMultiRoot: true, adoptedAnchor: true, platform: "win32" });
    assert.deepEqual(mutate(plan), { start: 1, deleteCount: 2, add: [STALE] });
    assert.equal(mutate({ kind: "reclaim", index: 1, deleteCount: 2, add: [L] }), null);
    assert.equal(mutate({ kind: "replace", index: 2, add: [STALE] }), null);
    assert.equal(mutate({ kind: "append", index: 3, add: ["C:\\WORKTREES\\STALE"] }), null);
    assert.deepEqual(resolveMutation({ kind: "append", index: 3, add: ["/A"] }, ["/a"], "linux"), { start: 3, deleteCount: 0, add: ["/A"] });
  });
});
