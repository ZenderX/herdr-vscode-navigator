import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HerdrEvent, PaneInfo, PaneProcessInfo, SessionSnapshot } from "../../../herdr/types";
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

const paneEvent = (event: string, pane_id: string, cwd: string): HerdrEvent => ({ event, data: { type: event, pane: pane(pane_id, cwd) } });

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Foreground = PaneProcessInfo["foreground_processes"];
// An idle shell as herdr 0.9.5 reports it on Windows: the shell is the only foreground process and its cwd is the spawn folder.
const shell = (cwd: string): Foreground => [{ pid: 100, name: "bash.exe", cwd }];

function setup(initial: CwdRecord["panes"] = {}) {
  const state = {
    snapshots: [] as SessionSnapshot[],
    fetches: 0,
    lease: true,
    plugin: "absent" as PluginState,
    writes: [] as CwdRecord[],
    sent: [] as { paneId: string; text: string }[],
    logs: [] as string[],
    foreground: {} as Record<string, Foreground>,
    infoCalls: [] as string[],
    // The MSYS probe's folder per pane; absent means the inner shell is not resolvable.
    msys: {} as Record<string, string>,
    probes: [] as string[][],
    // Busy checks left per pane before its shell turns idle; each look builds a fresh check.
    busy: {} as Record<string, number>,
    looks: 0,
    now: 0,
    onSleep: async (): Promise<void> => undefined,
  };
  let stored: CwdRecord = { ...emptyRecord("pipe"), panes: initial };
  const service = createReturnService({
    platform: "win32",
    log: (level, msg) => void (level !== "debug" && state.logs.push(msg)),
    clock: {
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
      processInfo: async (paneId): Promise<PaneProcessInfo> => {
        state.infoCalls.push(paneId);
        return { pane_id: paneId, shell_pid: 100, foreground_processes: state.foreground[paneId] ?? [] };
      },
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
    busyCheck: () => {
      state.looks++;
      return async ({ pane_id }) => {
        const left = state.busy[pane_id] ?? 0;
        state.busy[pane_id] = left - 1;
        return left > 0;
      };
    },
    probeShells: async (panes) => {
      state.probes.push(panes.map(({ paneId }) => paneId));
      return new Map(panes.map(({ paneId }) => [paneId, paneId in state.msys ? { cwd: state.msys[paneId], source: "msys" as const } : undefined]));
    },
  });
  return { service, state, stored: () => stored };
}

describe("returnService", () => {
  it("records Git Bash folders from the MSYS probe on connect, focus and pane events while herdr's cwd stays in spawn form, learns spawn folders and shell pids from process info, prunes closed panes, takes one snapshot for a tab close, records only while holding the lease, and checks an activation's first snapshot for a restart by shell pid", async () => {
    const t = setup();
    const me = "C:\\Users\\me";
    // w1:p1 is Git Bash without OSC 7 (herdr's cwd is its spawn folder forever); w1:p2 is PowerShell (herdr's cwd is live).
    t.state.foreground = { "w1:p1": shell("C:\\Users\\me\\"), "w1:p2": shell("C:\\two\\") };
    t.state.msys = { "w1:p1": me };
    const gitBash = pane("w1:p1", "C:\\Users\\me\\");
    t.state.snapshots = [snapshotOf(gitBash, pane("w1:p2", "C:\\two"))];
    await t.service.reconcile();
    await settle();
    assert.deepEqual(t.state.probes, [["w1:p1"]], "only the spawn-form pane is probed");
    assert.deepEqual(t.stored().panes, { "w1:p1": { spawn: me, folder: me, shellPid: 100 }, "w1:p2": { folder: "C:\\two", spawn: "C:\\two", shellPid: 100 } });

    // A cd in a prompt that sets no title pushes nothing; the next focus change records it from the probe.
    t.state.msys = { "w1:p1": "C:\\live" };
    t.service.onEvent({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p2", workspace_id: "w1" } });
    await settle();
    assert.deepEqual(t.stored().panes["w1:p1"], { spawn: me, folder: "C:\\live", shellPid: 100 });
    assert.equal(t.state.fetches, 2, "a focus event records with a full snapshot");

    // The stock Git prompt's title push carries a spawn-form cwd: the event's pane alone is probed, without a snapshot.
    t.state.msys = { "w1:p1": "C:\\next" };
    t.service.onEvent(paneEvent("pane_updated", "w1:p1", "C:\\Users\\me\\"));
    await settle();
    assert.deepEqual(t.stored().panes["w1:p1"], { spawn: me, folder: "C:\\next", shellPid: 100 });
    assert.deepEqual(t.state.probes.slice(1), [["w1:p1"], ["w1:p1"]]);
    assert.deepEqual(t.state.infoCalls, ["w1:p1", "w1:p2", "w1:p1", "w1:p2", "w1:p1", "w1:p1"], "pids once per pane, then one spawn lookup per folder change");
    t.service.onEvent({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" } });
    assert.deepEqual(Object.keys(t.stored().panes), ["w1:p1"]);
    assert.equal(t.state.fetches, 2, "pane events carry their own reading");

    // A tab close names no panes: one full snapshot prunes the panes that went with it.
    t.state.snapshots = [snapshotOf()];
    t.service.onEvent({ event: "tab_closed", data: { type: "tab_closed", tab_id: "w1:t1", workspace_id: "w1" } });
    await settle();
    assert.deepEqual(t.stored().panes, {});
    assert.equal(t.state.fetches, 3);

    t.state.lease = false;
    const writes = t.state.writes.length;
    t.service.onEvent(paneEvent("pane_created", "w1:p3", "C:\\x\\"));
    await t.service.reconcile();
    t.service.observeSnapshot(snapshotOf(pane("w1:p1", "C:\\moved")));
    assert.equal(t.state.fetches, 3, "only the lease-holding window records");
    assert.equal(t.state.writes.length, writes);

    // The first event of an activation brings a snapshot that is checked for freshly restored shells, so their
    // first folders never overwrite the record: a recorded id under another shell pid was respawned.
    const opened = setup({ "w1:p1": { folder: "C:\\live", spawn: me, shellPid: 99 } });
    opened.state.plugin = "present";
    opened.state.snapshots = [snapshotOf(gitBash)];
    opened.service.onEvent(paneEvent("pane_created", "w1:p2", "C:\\new\\"));
    await settle();
    assert.deepEqual(opened.state.logs, ["cwd-return: deferred to herdr plugin"]);
    assert.deepEqual(opened.state.writes, []);

    // Same pid: no restart, though herdr's cwd is in spawn form, and the probe confirms the recorded folder.
    const reopened = setup({ "w1:p1": { folder: "C:\\live", spawn: me, shellPid: 100 } });
    reopened.state.plugin = "present";
    reopened.state.msys = { "w1:p1": "C:\\live" };
    reopened.state.snapshots = [snapshotOf(gitBash)];
    await reopened.service.reconcile();
    assert.deepEqual(reopened.state.logs, []);
    assert.deepEqual(reopened.state.writes, []);
    assert.deepEqual(reopened.state.probes, [["w1:p1"]]);
  });

  it("after a reconnect pauses recording, waits until each shell is ready (a first prompt, or a Git Bash inner shell the probe resolves), checks each pane's spawn folder from its spawn form or else the busy check's process info, types one cd per qualifying pane, logs one line, then reconciles keeping the returned folders and resetting a reused id; looks again at a busy shell with a fresh process table until it is idle or the window ends, and leaves a pane still busy or not ready at the end at its recorded folder and shell pid so the restart is still seen; defers entirely to the plugin", async () => {
    const me = "C:\\Users\\me";
    const t = setup({
      "w1:p1": { folder: "C:\\a'b", spawn: me },
      "w1:p2": { folder: "C:\\other" },
      "w1:p3": { folder: "C:\\gone", spawn: me },
      "w1:p4": { folder: "C:\\theirs", spawn: "C:\\old" },
      // Live before the first look (a late reconnect): only process info can show where it was spawned.
      "w1:p5": { folder: "C:\\proc", spawn: me },
      "w1:p6": { folder: "C:\\lost", spawn: me },
      // A legacy entry: its spawn folder must come from the pane before the restart, never from the restored one.
      "w1:p7": { folder: "C:\\legacy" },
      // Git Bash: herdr's cwd stays in spawn form, and the pane is ready once the probe resolves its inner shell.
      "w1:p8": { folder: "C:\\bash", spawn: me },
    });
    t.state.msys = { "w1:p8": me };
    t.state.foreground = {
      // The spawn form wins over process info.
      "w1:p1": shell("C:\\elsewhere\\"),
      "w1:p2": shell("C:\\other\\"),
      "w1:p3": shell("C:\\Users\\me\\"),
      "w1:p5": shell("C:\\Users\\me\\"),
      "w1:p7": shell("C:\\Users\\me\\"),
    };
    const live = (...extra: PaneInfo[]) => [pane("w1:p2", "C:\\other"), pane("w1:p3", me), pane("w1:p5", me), pane("w1:p6", me), pane("w1:p7", me), pane("w1:p8", "C:\\Users\\me\\"), ...extra];
    t.state.snapshots = [
      snapshotOf(pane("w1:p1", "C:\\Users\\me\\"), pane("w1:p4", "C:\\Users\\me\\"), ...live()),
      snapshotOf(pane("w1:p1", me), pane("w1:p4", me), ...live()),
    ];
    let sleeps = 0;
    t.state.onSleep = async () => {
      sleeps++;
      // The restored shell's home folder is a live reading, but recording it now would erase the folder to return to.
      t.service.observeSnapshot(snapshotOf(pane("w1:p1", me), pane("w1:p7", me)));
      t.service.onEvent(paneEvent("pane_updated", "w1:p7", me));
      await t.service.reconcile();
    };
    await t.service.onReconnected();
    assert.equal(sleeps, 1, "the wait ends as soon as no recorded pane is in spawn form without a probe folder");
    // Pid lookups for the spawn-form panes, the busy checks (which never include the legacy entry), then the pids that key the next restart.
    assert.deepEqual(t.state.infoCalls.slice(0, 3), ["w1:p1", "w1:p4", "w1:p8"]);
    assert.deepEqual(t.state.infoCalls.slice(3, 8), ["w1:p1", "w1:p8", "w1:p3", "w1:p5", "w1:p6"], "the legacy entry is not looked up during its own return run");
    assert.deepEqual(t.state.infoCalls.slice(8), ["w1:p2", "w1:p3", "w1:p5", "w1:p6", "w1:p7"]);
    assert.deepEqual(t.state.sent, [
      { paneId: "w1:p1", text: "cd 'C:\\a'\\''b'" },
      { paneId: "w1:p5", text: "cd 'C:\\proc'" },
      { paneId: "w1:p8", text: "cd 'C:\\bash'" },
    ]);
    assert.deepEqual(t.state.logs, ["cwd-return: 3 panes returned, 5 skipped (same=1, unknown-spawn=2, mismatch=1, missing-folder=1)"]);
    // One write, after the run: the returned panes keep their folders though their shells have not run the cd yet.
    assert.equal(t.state.writes.length, 1);
    const pid = 100;
    assert.deepEqual(t.stored().panes, {
      "w1:p1": { folder: "C:\\a'b", spawn: me, shellPid: pid },
      "w1:p2": { folder: "C:\\other", shellPid: pid },
      "w1:p3": { folder: me, spawn: me, shellPid: pid },
      "w1:p4": { spawn: me, folder: me, shellPid: pid },
      "w1:p5": { folder: "C:\\proc", spawn: me, shellPid: pid },
      "w1:p6": { folder: me, spawn: me, shellPid: pid },
      "w1:p7": { folder: me, shellPid: pid },
      "w1:p8": { folder: "C:\\bash", spawn: me, shellPid: pid },
    });

    t.service.onEvent(paneEvent("pane_updated", "w1:p2", "C:\\next"));
    assert.equal(t.state.writes.length, 2, "recording resumes once the run ends");
    await settle();
    // Decided: the restored panes now key the next restart.
    assert.deepEqual(t.state.infoCalls.slice(13), ["w1:p2", "w1:p7"]);
    assert.deepEqual(t.stored().panes["w1:p7"], { folder: me, spawn: me, shellPid: pid });

    // A fresh Git Bash login shell runs its profile's children before the first prompt: a cd typed then would be lost.
    const homes = snapshotOf(pane("w1:p1", "C:\\Users\\me\\"), pane("w1:p2", "C:\\Users\\me\\"));
    const retried = setup({ "w1:p1": { folder: "C:\\work", spawn: me, shellPid: 99 }, "w1:p2": { folder: "C:\\proj", spawn: me, shellPid: 99 } });
    retried.state.msys = { "w1:p1": me, "w1:p2": me };
    retried.state.busy = { "w1:p1": 2, "w1:p2": Infinity };
    retried.state.snapshots = [homes];
    await retried.service.onReconnected();
    assert.deepEqual(retried.state.sent, [{ paneId: "w1:p1", text: "cd 'C:\\work'" }]);
    assert.deepEqual(retried.state.logs, ["cwd-return: 1 panes returned, 1 skipped (busy-timeout=1)"]);
    assert.equal(retried.state.looks, 21, "one fresh process table per 1 s look until the 20 s window ends");
    // The unreturned pane keeps its pre-restart folder and pid, even through a later reading of its restored shell.
    retried.service.onEvent(paneEvent("pane_updated", "w1:p2", "C:\\Users\\me\\"));
    await settle();
    assert.deepEqual(retried.stored().panes, { "w1:p1": { folder: "C:\\work", spawn: me, shellPid: pid }, "w1:p2": { folder: "C:\\proj", spawn: me, shellPid: 99 } });
    const next = setup(retried.stored().panes);
    next.state.plugin = "present";
    next.state.snapshots = [homes];
    await next.service.reconcile();
    assert.deepEqual(next.state.logs, ["cwd-return: deferred to herdr plugin"], "the next activation still sees the restart");

    // A shell whose prompt never came: its first live folder after the window is not recorded over the one to return to.
    const late = setup({ "w1:p1": { folder: "C:\\late", spawn: me, shellPid: 99 } });
    late.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me\\"))];
    late.state.onSleep = async () => {
      if (late.state.now >= 20_000) late.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me\\")), snapshotOf(pane("w1:p1", me))];
    };
    await late.service.onReconnected();
    assert.deepEqual(late.state.logs, ["cwd-return: 0 panes returned, 1 skipped (not-ready=1)"]);
    assert.equal(late.state.fetches, 22, "21 looks, then the reconcile snapshot with the live folder");
    assert.deepEqual(late.stored().panes, { "w1:p1": { folder: "C:\\late", spawn: me, shellPid: 99 } });

    const deferred = setup({ "w1:p1": { folder: "C:\\proj" } });
    deferred.state.plugin = "present";
    deferred.state.snapshots = [snapshotOf(pane("w1:p1", "C:\\Users\\me"))];
    await deferred.service.onReconnected();
    assert.deepEqual(deferred.state.sent, []);
    assert.equal(deferred.state.fetches, 0);
    assert.deepEqual(deferred.state.logs, ["cwd-return: deferred to herdr plugin"]);
  });
});
