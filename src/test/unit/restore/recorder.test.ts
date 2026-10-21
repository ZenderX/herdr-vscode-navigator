import assert from "node:assert/strict";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import { defaultSocketName, isDefaultSessionSocket } from "../../../restore/defaultSocket";
import { HEARTBEAT_MS, ManifestRecorder, ManifestStore, buildManifest, parseManifest } from "../../../restore/recorder";
import type { ManifestFs, RecorderFs, StoreClock } from "../../../restore/recorder";
import type { RestoreManifest } from "../../../restore/manifest";
import type { LoadedSessionFile } from "../../../restore/sessionFile";

const SPAWN = "C:\\Users\\me\\proj\\";
const LIVE = "C:\\Users\\me\\other";
const NOW = new Date("2026-01-02T00:00:00.000Z");

function sessionFile(extra: Record<string, unknown> = {}): LoadedSessionFile {
  return {
    path: "C:\\Users\\me\\AppData\\herdr\\session.json",
    session: {
      version: 3,
      workspaces: [
        {
          id: "w4",
          identity_cwd: SPAWN,
          public_pane_numbers: { "7": 1, "9": 2 },
          tabs: [{ panes: { "7": { cwd: SPAWN, agent_session: { value: "agent-1" } }, "9": { cwd: SPAWN } } }],
          ...extra,
        },
      ],
    },
  };
}

function pane(id: string, cwd: string, focused = false): PaneInfo {
  return { pane_id: `w4:${id}`, terminal_id: "t", workspace_id: "w4", tab_id: "w4:t1", focused, cwd };
}

function snapshot(panes: PaneInfo[], focusedPane: string | null = "w4:p1"): SessionSnapshot {
  return {
    focused_workspace_id: "w4",
    focused_tab_id: "w4:t1",
    focused_pane_id: focusedPane,
    panes,
    tabs: [],
    workspaces: [{ workspace_id: "w4", label: "proj" }],
  };
}

describe("buildManifest", () => {
  it("joins a live pane to the persisted pane with the same public number", () => {
    const { manifest, skipped } = buildManifest(sessionFile(), snapshot([pane("p1", LIVE), pane("p2", SPAWN)]), undefined, NOW, "win32");
    const [workspace] = manifest.workspaces;
    assert.deepEqual(skipped, []);
    assert.equal(workspace?.id, "w4");
    assert.deepEqual(
      workspace?.panes.map(({ internalId, publicNumber, spawnCwd, liveCwd, agentSessionId }) => ({ internalId, publicNumber, spawnCwd, liveCwd, agentSessionId })),
      [
        { internalId: "7", publicNumber: 1, spawnCwd: SPAWN, liveCwd: LIVE, agentSessionId: "agent-1" },
        { internalId: "9", publicNumber: 2, spawnCwd: SPAWN, liveCwd: "C:\\Users\\me\\proj", agentSessionId: undefined },
      ],
    );
  });

  it("skips and reports a pane with no persisted counterpart", () => {
    const { manifest, skipped } = buildManifest(sessionFile(), snapshot([pane("p1", LIVE), pane("p5", LIVE)]), undefined, NOW, "win32");
    assert.deepEqual(skipped, ["w4:p5"]);
    assert.equal(manifest.workspaces[0]?.panes.length, 1);
  });

  it("uses the git root of the focused pane as the folder, else its live cwd", () => {
    const withRoot = buildManifest(sessionFile(), snapshot([pane("p1", LIVE, true)]), undefined, NOW, "win32", { focusedFolder: "C:\\Users\\me\\other" });
    assert.equal(withRoot.manifest.workspaces[0]?.folder, "C:\\Users\\me\\other");
    const rootAbove = buildManifest(sessionFile(), snapshot([pane("p1", "C:\\Users\\me\\other\\src", true)]), undefined, NOW, "win32", {
      focusedFolder: "C:\\Users\\me\\other",
    });
    assert.equal(rootAbove.manifest.workspaces[0]?.folder, "C:\\Users\\me\\other");
    const plain = buildManifest(sessionFile(), snapshot([pane("p1", LIVE, true)]), undefined, NOW, "win32");
    assert.equal(plain.manifest.workspaces[0]?.folder, LIVE);
  });

  it("prefers a probed live cwd over the snapshot reading", () => {
    const probed = new Map([["w4:p1", "C:\\Users\\me\\probed"]]);
    const { manifest } = buildManifest(sessionFile(), snapshot([pane("p1", SPAWN, true)]), undefined, NOW, "win32", { liveCwds: probed });
    assert.equal(manifest.workspaces[0]?.panes[0]?.liveCwd, "C:\\Users\\me\\probed");
  });

  it("keeps earlier entries for a pane missing from one poll while it is still in the file", () => {
    const first = buildManifest(sessionFile(), snapshot([pane("p1", LIVE), pane("p2", "C:\\Users\\me\\two")]), undefined, NOW, "win32").manifest;
    const later = new Date("2026-01-02T00:00:10.000Z");
    const second = buildManifest(sessionFile(), snapshot([pane("p1", LIVE)]), first, later, "win32").manifest;
    assert.equal(second.workspaces[0]?.panes.find(({ internalId }) => internalId === "9")?.liveCwd, "C:\\Users\\me\\two");
    assert.equal(second.observedAt, later.toISOString());
  });

  it("drops kept entries whose pane left the file or changed spawn folder", () => {
    const first = buildManifest(sessionFile(), snapshot([pane("p1", LIVE), pane("p2", LIVE)]), undefined, NOW, "win32").manifest;
    const file = sessionFile();
    const [workspace] = file.session.workspaces;
    const [tab] = workspace?.tabs ?? [];
    if (tab) tab.panes = { "7": { cwd: "C:\\Users\\me\\moved" } };
    const second = buildManifest(file, snapshot([]), first, NOW, "win32").manifest;
    assert.deepEqual(second.workspaces, []);
  });

  it("does not let a stale spawn-folder reading erase an earlier live reading", () => {
    const first = buildManifest(sessionFile(), snapshot([pane("p1", LIVE)]), undefined, NOW, "win32").manifest;
    const second = buildManifest(sessionFile(), snapshot([pane("p1", SPAWN)]), first, NOW, "win32").manifest;
    assert.equal(second.workspaces[0]?.panes[0]?.liveCwd, LIVE);
  });

  it("keeps a pane's observedAt while its live cwd is unchanged", () => {
    const first = buildManifest(sessionFile(), snapshot([pane("p1", LIVE)]), undefined, NOW, "win32").manifest;
    const later = new Date("2026-01-02T01:00:00.000Z");
    const second = buildManifest(sessionFile(), snapshot([pane("p1", LIVE)]), first, later, "win32").manifest;
    assert.equal(second.workspaces[0]?.panes[0]?.observedAt, NOW.toISOString());
  });

  it("ignores a previous manifest recorded for another session file", () => {
    const first = buildManifest(sessionFile(), snapshot([pane("p1", LIVE)]), undefined, NOW, "win32").manifest;
    const other = { ...first, sessionFilePath: "C:\\elsewhere\\session.json" };
    const second = buildManifest(sessionFile(), snapshot([]), other, NOW, "win32").manifest;
    assert.deepEqual(second.workspaces, []);
  });
});

describe("parseManifest", () => {
  it("rejects garbage and other versions", () => {
    assert.equal(parseManifest("nope"), undefined);
    assert.equal(parseManifest(JSON.stringify({ manifestVersion: 2, sessionFilePath: "p", observedAt: "t", workspaces: [] })), undefined);
  });
});

function fakeClock(): StoreClock & { tick(ms: number): void; pendingCount(): number } {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    tick(ms) {
      now += ms;
      for (const [id, { at, fn }] of [...timers]) {
        if (at > now) continue;
        timers.delete(id);
        fn();
      }
    },
    pendingCount: () => timers.size,
  };
}

function fakeFs(): ManifestFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mkdir: async () => void calls.push("mkdir"),
    writeFile: async (path) => void calls.push(`write ${path.endsWith(".tmp") ? "tmp" : "final"}`),
    rename: async (_from, to) => void calls.push(`rename ${to}`),
  };
}

function manifest(observedAt: string, liveCwd = LIVE): RestoreManifest {
  return {
    manifestVersion: 1,
    sessionFilePath: "p",
    observedAt,
    workspaces: [{ id: "w4", label: "proj", folder: liveCwd, panes: [{ internalId: "7", publicNumber: 1, spawnCwd: SPAWN, liveCwd, observedAt: "pane" }] }],
  };
}

describe("ManifestStore", () => {
  const log = (): void => undefined;

  function store(): { store: ManifestStore; fs: ReturnType<typeof fakeFs>; clock: ReturnType<typeof fakeClock> } {
    const fs = fakeFs();
    const clock = fakeClock();
    return { store: new ManifestStore({ path: "C:\\store\\m.json", dir: "C:\\store", fs, clock, debounceMs: 5000, log }), fs, clock };
  }

  it("writes a temp file then renames it over the target", async () => {
    const { store: s, fs, clock } = store();
    s.save(manifest("a"));
    clock.tick(0);
    await s.flush();
    assert.deepEqual(fs.calls, ["mkdir", "write tmp", "rename C:\\store\\m.json"]);
  });

  it("debounces: changes inside the window collapse into one later write", async () => {
    const { store: s, fs, clock } = store();
    s.save(manifest("a", "C:\\one"));
    clock.tick(0);
    await s.flush();
    fs.calls.length = 0;
    s.save(manifest("b", "C:\\two"));
    s.save(manifest("c", "C:\\three"));
    clock.tick(4000);
    await Promise.resolve();
    assert.equal(fs.calls.length, 0);
    clock.tick(1000);
    await s.flush();
    assert.equal(fs.calls.filter((call) => call.startsWith("rename")).length, 1);
  });

  it("does not write when only observedAt moved, until the heartbeat is due", async () => {
    const { store: s, fs, clock } = store();
    s.save(manifest("a"));
    await s.flush();
    fs.calls.length = 0;
    clock.tick(10_000);
    s.save(manifest("b"));
    assert.equal(clock.pendingCount(), 0);
    await s.flush();
    assert.equal(fs.calls.length, 0);
    clock.tick(HEARTBEAT_MS);
    s.save(manifest("c"));
    await s.flush();
    assert.equal(fs.calls.filter((call) => call.startsWith("rename")).length, 1);
  });
});

describe("ManifestRecorder", () => {
  function recorder(hosting: boolean): { recorder: ManifestRecorder; saved: RestoreManifest[]; reads: { stat: number; read: number } } {
    const saved: RestoreManifest[] = [];
    const reads = { stat: 0, read: 0 };
    const file = sessionFile();
    const fs: RecorderFs = {
      stat: async () => {
        reads.stat += 1;
        return { mtimeMs: 1 };
      },
      readFile: async () => {
        reads.read += 1;
        return JSON.stringify(file.session);
      },
    };
    return {
      saved,
      reads,
      recorder: new ManifestRecorder({
        platform: "win32",
        sessionFilePath: file.path,
        fs,
        store: { save: (m) => void saved.push(m) },
        isHosting: () => hosting,
        isDefaultSocket: () => true,
        probeLive: async () => undefined,
        gitRoot: async (dir) => dir,
        now: () => NOW,
        log: () => undefined,
      }),
    };
  }

  it("never records, reads or writes when the window is not hosting herdr", async () => {
    const { recorder: r, saved, reads } = recorder(false);
    await r.observe(snapshot([pane("p1", LIVE, true)]), "s");
    assert.deepEqual(saved, []);
    assert.deepEqual(reads, { stat: 0, read: 0 });
  });

  it("stops recording once the socket setting moves to another server", async () => {
    const file = sessionFile();
    const saved: RestoreManifest[] = [];
    const defaultSocket = defaultSocketName(file.path, "win32");
    const r = new ManifestRecorder({
      platform: "win32",
      sessionFilePath: file.path,
      fs: { stat: async () => ({ mtimeMs: 1 }), readFile: async () => JSON.stringify(file.session) },
      store: { save: (m) => void saved.push(m) },
      isHosting: () => true,
      isDefaultSocket: (socket) => isDefaultSessionSocket(file.path, socket, "win32"),
      probeLive: async () => undefined,
      gitRoot: async (dir) => dir,
      now: () => NOW,
      log: () => undefined,
    });
    await r.observe(snapshot([pane("p1", LIVE, true)]), defaultSocket);
    assert.equal(saved.length, 1);
    // A snapshot fetched from another socket is dropped even if the setting is back on the default by observe time.
    await r.observe(snapshot([pane("p1", "C:\\Users\\me\\elsewhere", true)]), "\\\\.\\pipe\\herdr-other.sock");
    assert.equal(saved.length, 1);
  });

  it("reads session.json once while its mtime is unchanged", async () => {
    const { recorder: r, saved, reads } = recorder(true);
    await r.observe(snapshot([pane("p1", LIVE, true)]), "s");
    await r.observe(snapshot([pane("p1", LIVE, true)]), "s");
    assert.equal(saved.length, 2);
    assert.deepEqual(reads, { stat: 2, read: 1 });
  });

  it("logs an unjoinable pane once per workspace, however many snapshots repeat it", async () => {
    const file = sessionFile();
    file.session.workspaces.push({ id: "w5", identity_cwd: SPAWN, public_pane_numbers: { "3": 1 }, tabs: [{ panes: { "3": { cwd: SPAWN } } }] });
    const logs: string[] = [];
    const r = new ManifestRecorder({
      platform: "win32",
      sessionFilePath: file.path,
      fs: { stat: async () => ({ mtimeMs: 1 }), readFile: async () => JSON.stringify(file.session) },
      store: { save: () => undefined },
      isHosting: () => true,
      isDefaultSocket: () => true,
      probeLive: async () => undefined,
      gitRoot: async (dir) => dir,
      now: () => NOW,
      log: (_level, message) => void logs.push(message),
    });
    const w5Pane = (id: string): PaneInfo => ({ ...pane(id, LIVE), pane_id: `w5:${id}`, workspace_id: "w5" });
    const snap = snapshot([pane("p1", LIVE, true), pane("p5", LIVE), pane("p6", LIVE), w5Pane("p9")]);
    await r.observe(snap, "s");
    await r.observe(snap, "s");
    const skipLogs = logs.filter((message) => message.startsWith("restore manifest: pane "));
    assert.equal(skipLogs.length, 2);
    assert.match(skipLogs[0] ?? "", /^restore manifest: pane w4:p5 has no persisted pane yet/);
    assert.match(skipLogs[1] ?? "", /^restore manifest: pane w5:p9 has no persisted pane yet/);
  });
});
