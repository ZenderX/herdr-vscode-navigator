import assert from "node:assert/strict";
import type { PaneInfo } from "../../../herdr/types";
import { dropPanes, emptyRecord, mergePane, mergeRecord, parseRecord, recordKey } from "../../../restore/record";
import type { CwdRecord } from "../../../restore/record";
import { isRestart } from "../../../restore/restartDetect";
import { anyNotReady, paneHasAgent, planReturn, summary, type PlannerPane } from "../../../restore/returnPlanner";

const pane = (paneId: string): PaneInfo => ({ pane_id: paneId, terminal_id: "t", workspace_id: "w1", tab_id: "t1", focused: false });

describe("cwd return rules", () => {
  it("keeps a live folder over a spawn-form reading of the same spawn folder, resets an entry whose spawn folder changed, drops vanished panes, and still reads version-1 records", () => {
    const key = recordKey("\\\\.\\pipe\\herdr-default");
    assert.equal(key, "__._pipe_herdr-default");
    const record: CwdRecord = { ...emptyRecord(key), panes: { "w1:p1": { folder: "C:\\live", spawn: "C:\\Users\\me" }, "w1:p2": { folder: "C:\\gone" } } };
    const readings = [
      // Windows paths compare case-insensitively and the spawn form's trailing separator is not part of the folder.
      { paneId: "w1:p1", rawCwd: "c:\\users\\me\\" },
      { paneId: "w1:p3", rawCwd: "/c/new" },
      { paneId: "w1:p4", rawCwd: "C:\\Users\\me\\" },
    ];

    const first = mergeRecord(record, readings, "win32");
    assert.deepEqual(first.record.panes, { "w1:p1": { folder: "C:\\live", spawn: "C:\\users\\me" }, "w1:p3": { folder: "C:\\new" }, "w1:p4": { spawn: "C:\\Users\\me" } });
    assert.equal(first.changed, true);
    assert.equal(mergeRecord(first.record, readings, "win32").changed, false);

    // A reused id: the pane now in this slot was spawned elsewhere, so the folder recorded for the old pane must go.
    const reused = mergePane(first.record, { paneId: "w1:p1", rawCwd: "C:\\other\\" }, "win32");
    assert.deepEqual(reused.record.panes["w1:p1"], { spawn: "C:\\other" });
    const live = mergePane(reused.record, { paneId: "w1:p1", rawCwd: "C:\\work" }, "win32");
    assert.deepEqual(live.record.panes["w1:p1"], { spawn: "C:\\other", folder: "C:\\work" });
    assert.equal(mergePane(live.record, { paneId: "w1:p3", rawCwd: null }, "win32").changed, false);
    assert.deepEqual(Object.keys(dropPanes(live.record, ["w1:p1"]).record.panes), ["w1:p3", "w1:p4"]);

    assert.deepEqual(parseRecord(live.record), live.record);
    assert.deepEqual(parseRecord({ version: 1, key, panes: { "w1:p1": "C:\\a" } }), { version: 2, key, panes: { "w1:p1": { folder: "C:\\a" } } });
    assert.equal(parseRecord({ version: 1, key, panes: { "w1:p1": 3 } }), undefined);
    assert.equal(parseRecord({ version: 2, key, panes: { "w1:p1": { folder: 3 } } }), undefined);
    assert.equal(parseRecord({ version: 2, key, panes: { "w1:p1": { folder: "C:\\a", shellPid: "100" } } }), undefined);
  });

  it("treats a lost-and-back socket or a first snapshot with a recorded pane id under a new shell pid as a restart, and nothing else", () => {
    // Git Bash entries hold probe folders while herdr's cwd stays in spawn form, so spawn form cannot signal a restart.
    const recorded = { "w1:p1": { folder: "C:\\work", spawn: "C:\\Users\\me", shellPid: 100 }, "w1:p2": { folder: "C:\\two", shellPid: 200 } };
    const same = new Map([["w1:p1", 100], ["w1:p2", 200]]);
    assert.equal(isRestart({ kind: "reconnected" }), true);
    assert.equal(isRestart({ kind: "connected", shellPids: same, recorded }), false);
    // A restart respawns every pane under its old id with a new pid.
    assert.equal(isRestart({ kind: "connected", shellPids: new Map([["w1:p1", 100], ["w1:p2", 201]]), recorded }), true);
    // An unrecorded pane, a pane known only by its spawn folder, and an entry without a pid (recorded before pids were kept) never count.
    assert.equal(isRestart({ kind: "connected", shellPids: new Map([["w1:p9", 1]]), recorded }), false);
    assert.equal(isRestart({ kind: "connected", shellPids: new Map([["w1:p1", 101]]), recorded: { "w1:p1": { spawn: "C:\\Users\\me", shellPid: 100 } } }), false);
    assert.equal(isRestart({ kind: "connected", shellPids: new Map([["w1:p1", 101]]), recorded: { "w1:p1": { folder: "C:\\work" } } }), false);
    assert.equal(isRestart({ kind: "connected", shellPids: new Map(), recorded }), false);
  });

  it("skips each pane for the first failing guard in the plugin's order, sends a pane only when both spawn folders are known and equal, and quotes the cd as one argument", () => {
    const me = "C:\\Users\\me";
    const recorded = {
      "w1:p1": { folder: "C:\\closed", spawn: me },
      "w1:p2": { folder: "C:\\same", spawn: me },
      // A legacy entry learned before spawn folders were stored: a reused id cannot be ruled out.
      "w1:p9": { folder: "C:\\legacy" },
      // The restored pane showed neither a spawn form nor a process-info cwd.
      "w1:p10": { folder: "C:\\unseen", spawn: me },
      "w1:p7": { folder: "C:\\theirs", spawn: "C:\\old" },
      "w1:p3": { folder: "C:\\missing", spawn: me },
      "w1:p4": { folder: "C:\\agent", spawn: me },
      "w1:p5": { folder: "C:\\waiting", spawn: me },
      "w1:p6": { folder: "C:\\a'b", spawn: me },
      // Known only by its spawn folder: nothing to return to.
      "w1:p8": { spawn: me },
      // Git Bash panes: herdr's cwd stays in spawn form, so the MSYS probe's folder decides `same` and readiness.
      "w1:p11": { folder: "C:\\bash", spawn: me },
      "w1:p12": { folder: "C:\\proj", spawn: me },
    };
    const idle = (paneId: string, rawCwd: string, spawn = "C:\\Users\\me\\"): PlannerPane => ({ paneId, rawCwd, live: undefined, spawn, hasAgent: false, busy: false });
    const panes: PlannerPane[] = [
      idle("w1:p2", "c:\\same\\"),
      idle("w1:p9", me),
      { ...idle("w1:p10", me), spawn: undefined },
      idle("w1:p7", me),
      idle("w1:p3", me),
      { ...idle("w1:p4", me), hasAgent: true },
      idle("w1:p5", "C:\\Users\\me\\"),
      // Case, slash direction and the trailing separator do not make another folder.
      idle("w1:p6", me, "c:/users/me/"),
      idle("w1:p8", me),
      { ...idle("w1:p11", "C:\\Users\\me\\"), live: "c:\\bash" },
      { ...idle("w1:p12", "C:\\Users\\me\\"), live: me },
    ];
    const folderExists = (folder: string): boolean | undefined => (folder === "C:\\missing" ? false : true);

    const plan = planReturn({ recorded, panes, folderExists, platform: "win32" });
    assert.deepEqual(plan.actions, [
      { paneId: "w1:p6", text: "cd 'C:\\a'\\''b'" },
      { paneId: "w1:p12", text: "cd 'C:\\proj'" },
    ]);
    assert.deepEqual(
      plan.skips.map(({ paneId, reason }) => `${paneId}=${reason}`),
      ["w1:p1=no-pane", "w1:p2=same", "w1:p9=unknown-spawn", "w1:p10=unknown-spawn", "w1:p7=mismatch", "w1:p3=missing-folder", "w1:p4=agent", "w1:p5=not-ready", "w1:p11=same"],
    );
    assert.equal(anyNotReady(plan), true);
    assert.equal(
      summary(plan.actions, plan.skips),
      "cwd-return: 2 panes returned, 9 skipped (no-pane=1, same=2, unknown-spawn=2, mismatch=1, missing-folder=1, agent=1, not-ready=1)",
    );

    const settled = panes.map((p) => (p.paneId === "w1:p5" ? idle("w1:p5", me) : p.paneId === "w1:p6" ? { ...p, busy: true } : p));
    const later = planReturn({ recorded, panes: settled, folderExists: () => undefined, platform: "win32" });
    assert.equal(anyNotReady(later), false);
    assert.equal(
      summary([], [{ paneId: "w1:p11", reason: "error" }, ...later.skips]),
      "cwd-return: 0 panes returned, 12 skipped (no-pane=1, same=2, unknown-spawn=2, mismatch=1, missing-folder=5, error=1)",
    );
    const busyOnly = planReturn({ recorded, panes: settled, folderExists: () => true, platform: "win32" });
    assert.equal(summary(busyOnly.actions, busyOnly.skips), "cwd-return: 3 panes returned, 8 skipped (no-pane=1, same=2, unknown-spawn=2, mismatch=1, agent=1, busy=1)");
    assert.equal(summary([{ paneId: "w1:p6", text: "cd 'C:\\a'\\''b'" }], []), "cwd-return: 1 panes returned, 0 skipped");

    assert.equal(paneHasAgent({ ...pane("w1:p1"), agent: null }), false);
    assert.equal(paneHasAgent({ ...pane("w1:p1"), agent_session: "s" }), true);
  });
});
