import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { PaneInfo, PaneProcessInfo, SessionSnapshot } from "../../../herdr/types";
import type { PluginState } from "../../../launch/pluginDetect";
import { emptyRecord } from "../../../restore/record";
import type { CwdRecord } from "../../../restore/record";
import { createReturnService } from "../../../restore/returnService";

function pane(pane_id: string, cwd: string): PaneInfo {
  return { pane_id, terminal_id: `t-${pane_id}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd };
}

function snapshotOf(...panes: PaneInfo[]): SessionSnapshot {
  return { focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: null, panes, tabs: [], workspaces: [] };
}

function setup(initial: CwdRecord["panes"] = {}) {
  const state = {
    snapshots: [] as SessionSnapshot[],
    fetches: 0,
    lease: true,
    plugin: "absent" as PluginState,
    writes: [] as CwdRecord[],
    sent: [] as { paneId: string; text: string }[],
    logs: [] as string[],
    now: 0,
    onSleep: async (): Promise<void> => undefined,
  };
  let stored: CwdRecord = { ...emptyRecord("pipe"), panes: initial };
  const service = createReturnService({
    platform: "win32",
    log: (level, msg) => void (level !== "debug" && state.logs.push(msg)),
    clock: {
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
      now: () => state.now,
      sleep: async (ms) => {
        state.now += ms;
        await state.onSleep();
      },
    },
    pipeName: () => "pipe",
    client: () => ({
      snapshot: async () => {
        state.fetches++;
        const next = state.snapshots.length > 1 ? state.snapshots.shift() : state.snapshots[0];
        if (!next) throw new Error("no snapshot queued");
        return next;
      },
      processInfo: async (paneId): Promise<PaneProcessInfo> => ({ pane_id: paneId, shell_pid: 100, foreground_processes: [] }),
      sendInput: async (paneId, text) => void state.sent.push({ paneId, text }),
    }),
    store: {
      read: () => stored,
      write: (record) => {
        stored = record;
        state.writes.push(record);
      },
    },
    isDirectory: async (folder) => folder !== "C:\\gone",
    connected: () => true,
    holdsLease: () => state.lease,
    pluginState: () => state.plugin,
    busyCheck: () => async () => false,
  });
  return { service, state, stored: () => stored };
}

describe("returnService", () => {
  it("records live folders only while holding the lease, never lets a spawn-form reading overwrite one, drops vanished panes, and checks the first snapshot for a restart before recording it", async () => {
    const t = setup();
    t.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\live"), pane("w1:p2", "C:\\two"))];
    await t.service.poll();
    assert.deepEqual(t.stored().panes, { "w1:p1": "C:\\live", "w1:p2": "C:\\two" });

    // A restored shell before its first prompt still reports its spawn folder with a trailing separator.
    t.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me\\"), pane("w1:p2", "C:\\two"))];
    await t.service.poll();
    assert.equal(t.state.writes.length, 1);

    t.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me\\"))];
    await t.service.poll();
    assert.deepEqual(t.stored().panes, { "w1:p1": "C:\\live" });
    assert.equal(t.state.writes.length, 2);

    t.state.lease = false;
    const fetches = t.state.fetches;
    await t.service.poll();
    t.service.observeSnapshot(snapshotOf(pane("w1:p1", "C:\\moved")));
    assert.equal(t.state.fetches, fetches, "only the lease-holding window records");
    assert.equal(t.state.writes.length, 2);

    // A window opening onto freshly restored shells with a record present treats them as a restart, not a reading.
    const opened = setup({ "w1:p1": "C:\\live" });
    opened.state.plugin = "present";
    opened.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me\\"))];
    await opened.service.poll();
    assert.deepEqual(opened.state.logs, ["cwd-return: deferred to herdr plugin"]);
    assert.deepEqual(opened.state.writes, []);
  });

  it("after a reconnect pauses recording, waits for the first prompts, types one cd per qualifying pane, logs one line, and defers entirely to the plugin", async () => {
    const t = setup({ "w1:p1": "C:\\a'b", "w1:p2": "C:\\other", "w1:p3": "C:\\gone" });
    t.state.snapshots = [
      snapshotOf(pane("w1:p1", "C:\\Users\\me\\"), pane("w1:p2", "C:\\other"), pane("w1:p3", "C:\\Users\\me")),
      snapshotOf(pane("w1:p1", "C:\\Users\\me"), pane("w1:p2", "C:\\other"), pane("w1:p3", "C:\\Users\\me")),
    ];
    let sleeps = 0;
    t.state.onSleep = async () => {
      sleeps++;
      // The restored shell's home folder is a live reading, but recording it now would erase the folder to return to.
      t.service.observeSnapshot(snapshotOf(pane("w1:p1", "C:\\Users\\me")));
      await t.service.poll();
    };
    await t.service.onReconnected();
    assert.equal(sleeps, 1, "the wait ends as soon as no recorded pane is in spawn form");
    assert.deepEqual(t.state.writes, []);
    assert.deepEqual(t.state.sent, [{ paneId: "w1:p1", text: "cd 'C:\\a'\\''b'" }]);
    assert.deepEqual(t.state.logs, ["cwd-return: 1 panes returned, 2 skipped (same=1, missing-folder=1)"]);

    // Recording resumes once the run ends.
    await t.service.poll();
    assert.equal(t.state.writes.length, 1);

    const deferred = setup({ "w1:p1": "C:\\proj" });
    deferred.state.plugin = "present";
    deferred.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me"))];
    await deferred.service.onReconnected();
    assert.deepEqual(deferred.state.sent, []);
    assert.equal(deferred.state.fetches, 0);
    assert.deepEqual(deferred.state.logs, ["cwd-return: deferred to herdr plugin"]);
  });
});
