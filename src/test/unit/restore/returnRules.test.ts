import assert from "node:assert/strict";
import type { PaneInfo } from "../../../herdr/types";
import { emptyRecord, isCwdRecord, mergeRecord, recordKey } from "../../../restore/record";
import { isRestart } from "../../../restore/restartDetect";
import { anyNotReady, paneHasAgent, planReturn, summary, type PlannerPane } from "../../../restore/returnPlanner";

const pane = (paneId: string): PaneInfo => ({ pane_id: paneId, terminal_id: "t", workspace_id: "w1", tab_id: "t1", focused: false });

describe("cwd return rules", () => {
  it("keeps a live folder over a spawn-form reading, drops vanished panes, and reports changes only when the record moves", () => {
    const key = recordKey("\\\\.\\pipe\\herdr-default");
    assert.equal(key, "__._pipe_herdr-default");
    const record = { ...emptyRecord(key), panes: { "w1:p1": "C:\\live", "w1:p2": "C:\\gone" } };
    const readings = [
      { paneId: "w1:p1", rawCwd: "C:\\Users\\me\\" },
      { paneId: "w1:p3", rawCwd: "/c/new" },
      { paneId: "w1:p4", rawCwd: "C:\\Users\\me\\" },
    ];

    const first = mergeRecord(record, readings, "win32");
    assert.deepEqual(first, { record: { version: 1, key, panes: { "w1:p1": "C:\\live", "w1:p3": "C:\\new" } }, changed: true });
    assert.equal(mergeRecord(first.record, readings, "win32").changed, false);
    assert.equal(isCwdRecord(first.record), true);
    assert.equal(isCwdRecord({ version: 1, key, panes: { "w1:p1": 3 } }), false);
  });

  it("treats a lost-and-back socket or a first snapshot with a recorded pane in spawn form as a restart, and nothing else", () => {
    const recordedPaneIds = new Set(["w1:p1", "w1:p2"]);
    const respawned = { paneId: "w1:p1", rawCwd: "C:\\Users\\me\\" };
    const live = { paneId: "w1:p2", rawCwd: "C:\\work" };
    // A shell without OSC 7 stays in spawn form forever and is never recorded, so it must not trip the check.
    const unrecordedSpawn = { paneId: "w1:p9", rawCwd: "/home/me/" };
    assert.equal(isRestart({ kind: "reconnected" }), true);
    assert.equal(isRestart({ kind: "connected", panes: [respawned, live, unrecordedSpawn], recordedPaneIds }), true);
    // The user changed folder while VS Code was closed: no recorded pane is in spawn form.
    const moved = { paneId: "w1:p1", rawCwd: "C:\\elsewhere" };
    assert.equal(isRestart({ kind: "connected", panes: [moved, live, unrecordedSpawn], recordedPaneIds }), false);
    assert.equal(isRestart({ kind: "connected", panes: [respawned], recordedPaneIds: new Set() }), false);
    assert.equal(isRestart({ kind: "connected", panes: [], recordedPaneIds }), false);
    // A drive root keeps its separator after the prompt, so it is not spawn form.
    assert.equal(isRestart({ kind: "connected", panes: [{ paneId: "w1:p1", rawCwd: "C:\\" }], recordedPaneIds }), false);
  });

  it("skips each pane for the first failing guard in the plugin's order and quotes the cd as one argument", () => {
    const recorded = {
      "w1:p1": "C:\\closed",
      "w1:p2": "C:\\same",
      "w1:p3": "C:\\missing",
      "w1:p4": "C:\\agent",
      "w1:p5": "C:\\waiting",
      "w1:p6": "C:\\a'b",
    };
    const idle = (paneId: string, rawCwd: string): PlannerPane => ({ paneId, rawCwd, hasAgent: false, busy: false });
    const panes: PlannerPane[] = [
      idle("w1:p2", "c:\\same\\"),
      idle("w1:p3", "C:\\Users\\me"),
      { ...idle("w1:p4", "C:\\Users\\me"), hasAgent: true },
      idle("w1:p5", "C:\\Users\\me\\"),
      idle("w1:p6", "C:\\Users\\me"),
    ];
    const folderExists = (folder: string): boolean | undefined => (folder === "C:\\missing" ? false : true);

    const plan = planReturn({ recorded, panes, folderExists, platform: "win32" });
    assert.deepEqual(plan.actions, [{ paneId: "w1:p6", text: "cd 'C:\\a'\\''b'" }]);
    assert.deepEqual(
      plan.skips.map(({ reason }) => reason),
      ["no-pane", "same", "missing-folder", "agent", "not-ready"],
    );
    assert.equal(anyNotReady(plan), true);
    assert.equal(
      summary(plan.actions, plan.skips),
      "cwd-return: 1 panes returned, 5 skipped (no-pane=1, same=1, missing-folder=1, agent=1, not-ready=1)",
    );

    const settled = panes.map((p) => (p.paneId === "w1:p5" ? idle("w1:p5", "C:\\Users\\me") : p.paneId === "w1:p6" ? { ...p, busy: true } : p));
    const later = planReturn({ recorded, panes: settled, folderExists: () => undefined, platform: "win32" });
    assert.equal(anyNotReady(later), false);
    assert.equal(
      summary([], [{ paneId: "w1:p9", reason: "error" }, ...later.skips]),
      "cwd-return: 0 panes returned, 7 skipped (no-pane=1, same=1, missing-folder=4, error=1)",
    );
    const busyOnly = planReturn({ recorded, panes: settled, folderExists: () => true, platform: "win32" });
    assert.equal(summary(busyOnly.actions, busyOnly.skips), "cwd-return: 2 panes returned, 4 skipped (no-pane=1, same=1, agent=1, busy=1)");
    assert.equal(summary([{ paneId: "w1:p6", text: "cd 'C:\\a'\\''b'" }], []), "cwd-return: 1 panes returned, 0 skipped");

    assert.equal(paneHasAgent({ ...pane("w1:p1"), agent: null }), false);
    assert.equal(paneHasAgent({ ...pane("w1:p1"), agent_session: "s" }), true);
  });
});
