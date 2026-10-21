import assert from "node:assert/strict";
import type { RestoreManifest } from "../../../restore/manifest";
import { BACKUPS_KEPT, repairSessionFolders } from "../../../restore/repair";
import type { RepairDeps } from "../../../restore/repair";
import type { ServerProbe } from "../../../restore/serverProbe";
import type { SessionPathResult } from "../../../restore/sessionFile";

const SESSION_PATH = "C:\\Users\\me\\AppData\\Roaming\\herdr\\session.json";
const MANIFEST_PATH = "C:\\store\\restore-manifest.json";
const BACKUP_DIR = "C:\\store\\herdr-session-backups";
const SPAWN = "C:\\Users\\me\\proj\\";
const NOW = new Date("2026-01-10T00:00:00Z");

function sessionText(version = 3): string {
  return JSON.stringify({
    version,
    workspaces: [
      {
        id: "w1",
        identity_cwd: SPAWN,
        tabs: [{ panes: { "1": { cwd: SPAWN } } }],
      },
    ],
  });
}

function manifestOf(overrides: Partial<RestoreManifest> = {}): RestoreManifest {
  return {
    manifestVersion: 1,
    sessionFilePath: SESSION_PATH,
    observedAt: "2026-01-09T00:00:00Z",
    workspaces: [
      {
        id: "w1",
        label: "other",
        folder: "C:\\Users\\me\\other",
        panes: [{ internalId: "1", publicNumber: 1, spawnCwd: SPAWN, liveCwd: "C:\\Users\\me\\other\\sub", observedAt: "2026-01-09T00:00:00Z" }],
      },
    ],
    ...overrides,
  };
}

interface Harness {
  deps: RepairDeps;
  files: Map<string, string>;
  logs: string[];
  ops: string[];
  setServer: (value: ServerProbe) => void;
  probed: string[];
}

const DEFAULT_SOCKET = `\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock`;

function harness(options: { session?: string; manifest?: RestoreManifest | string; located?: SessionPathResult; backups?: string[]; socket?: string } = {}): Harness {
  const files = new Map<string, string>();
  files.set(SESSION_PATH, options.session ?? sessionText());
  const manifest = options.manifest ?? manifestOf();
  files.set(MANIFEST_PATH, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const name of options.backups ?? []) files.set(`${BACKUP_DIR}/${name}`, "old");
  const logs: string[] = [];
  const ops: string[] = [];
  let server: ServerProbe = { state: "stopped" };
  const probed: string[] = [];
  const deps: RepairDeps = {
    platform: "win32",
    locate: () => options.located ?? { kind: "path", path: SESSION_PATH },
    socketName: () => options.socket ?? DEFAULT_SOCKET,
    probeServer: (name) => {
      probed.push(name);
      return Promise.resolve(server);
    },
    fs: {
      readFile: (path) => {
        const text = files.get(path);
        return text === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(text);
      },
      writeFile: (path, text) => {
        ops.push(`write ${path}`);
        files.set(path, text);
        return Promise.resolve();
      },
      rename: (from, to) => {
        ops.push(`rename ${from} ${to}`);
        const text = files.get(from);
        if (text === undefined) return Promise.reject(new Error("ENOENT"));
        files.delete(from);
        files.set(to, text);
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      readdir: () => Promise.resolve([...files.keys()].filter((key) => key.startsWith(`${BACKUP_DIR}/`)).map((key) => key.slice(BACKUP_DIR.length + 1))),
      rm: (path) => {
        files.delete(path);
        return Promise.resolve();
      },
    },
    manifestPath: MANIFEST_PATH,
    backupDir: BACKUP_DIR,
    now: () => NOW,
    log: (_level, message) => void logs.push(message),
  };
  return { deps, files, logs, ops, probed, setServer: (value) => void (server = value) };
}

const backupNames = (h: Harness): string[] => [...h.files.keys()].filter((key) => key.startsWith(`${BACKUP_DIR}/`));

describe("repairSessionFolders", () => {
  it("leaves the file alone while the herdr server is reachable", async () => {
    const h = harness();
    h.setServer({ state: "running" });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "herdr server is running" });
    assert.equal(h.files.get(SESSION_PATH), sessionText());
    assert.deepEqual(h.ops, []);
    assert.deepEqual(h.logs, ["restore repair: left alone: herdr server is running"]);
  });

  it("leaves the file alone when the server state is unknown", async () => {
    const h = harness();
    h.setServer({ state: "unknown", detail: "timeout" });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "herdr server state unknown (timeout)" });
    assert.deepEqual(h.ops, []);
    assert.equal(h.files.get(SESSION_PATH), sessionText());
  });

  it("writes nothing and does not probe when the socket override points at another server", async () => {
    const h = harness({ socket: "\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\sessions\\other\\herdr.sock" });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "socket override points at another server" });
    assert.deepEqual(h.ops, []);
    assert.deepEqual(h.probed, []);
  });

  it("proceeds when the override equals the default socket, probing the default socket", async () => {
    const h = harness();
    const outcome = await repairSessionFolders(h.deps);
    assert.equal(outcome.kind, "repaired");
    assert.deepEqual(h.probed, [DEFAULT_SOCKET]);
  });

  it("leaves the file alone when HERDR_SESSION or HERDR_CONFIG_PATH makes the layout unsupported", async () => {
    const h = harness({ located: { kind: "unsupported", reason: "HERDR_SESSION is set" } });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "HERDR_SESSION is set" });
    assert.deepEqual(h.ops, []);
  });

  it("leaves the file alone without a usable manifest", async () => {
    const h = harness({ manifest: "not json" });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "no usable restore manifest" });
    assert.deepEqual(h.ops, []);
  });

  it("writes no backup and no file for a session file of another version", async () => {
    const h = harness({ session: sessionText(4) });
    const outcome = await repairSessionFolders(h.deps);
    assert.equal(outcome.kind, "left");
    assert.deepEqual(h.ops, []);
    assert.deepEqual(backupNames(h), []);
    assert.equal(h.files.get(SESSION_PATH), sessionText(4));
  });

  it("passes the planner's leave reason through and writes nothing", async () => {
    const h = harness({ manifest: manifestOf({ observedAt: "2025-12-01T00:00:00Z" }) });
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "stale-manifest" });
    assert.deepEqual(h.ops, []);
  });

  it("backs up, writes a temp file next to the session file, renames it over, and logs each change", async () => {
    const h = harness();
    const outcome = await repairSessionFolders(h.deps);
    assert.equal(outcome.kind, "repaired");
    const backups = backupNames(h);
    assert.equal(backups.length, 1);
    assert.equal(h.files.get(backups[0] ?? ""), sessionText());
    assert.ok(h.ops.indexOf(`write ${backups[0]}`) < h.ops.indexOf(`write ${SESSION_PATH}.navigator-repair.tmp`));
    assert.ok(h.ops.includes(`rename ${SESSION_PATH}.navigator-repair.tmp ${SESSION_PATH}`));
    const repaired = JSON.parse(h.files.get(SESSION_PATH) ?? "") as { workspaces: Array<{ identity_cwd: string; tabs: Array<{ panes: Record<string, { cwd: string }> }> }> };
    assert.equal(repaired.workspaces[0]?.identity_cwd, "C:\\Users\\me\\other\\");
    assert.equal(repaired.workspaces[0]?.tabs[0]?.panes["1"]?.cwd, "C:\\Users\\me\\other\\sub\\");
    assert.deepEqual(h.logs, [
      "restore repair: repaired: workspace w1 pane 1: C:\\Users\\me\\proj\\ -> C:\\Users\\me\\other\\sub\\",
      "restore repair: repaired: workspace w1 identity_cwd: C:\\Users\\me\\proj\\ -> C:\\Users\\me\\other\\",
    ]);
  });

  it("keeps at most five backups, newest first to survive", async () => {
    const old = Array.from({ length: 6 }, (_, index) => `session-2025-01-0${index + 1}T00-00-00-000Z.json`);
    const h = harness({ backups: old });
    await repairSessionFolders(h.deps);
    const names = backupNames(h).map((path) => path.slice(BACKUP_DIR.length + 1));
    assert.equal(names.length, BACKUPS_KEPT);
    assert.ok(names.includes("session-2026-01-10T00-00-00-000Z.json"));
    assert.ok(!names.includes(old[0] ?? ""));
  });

  it("is a no-op the second time with the same manifest", async () => {
    const h = harness();
    await repairSessionFolders(h.deps);
    const after = h.files.get(SESSION_PATH);
    const opsBefore = h.ops.length;
    const second = await repairSessionFolders(h.deps);
    assert.deepEqual(second, { kind: "left", reason: "restore manifest already applied" });
    assert.equal(h.ops.length, opsBefore);
    assert.equal(h.files.get(SESSION_PATH), after);
  });

  it("leaves the original file unchanged when the rename fails and leaves no temp file", async () => {
    const h = harness();
    const original = h.deps.fs.rename;
    h.deps.fs.rename = (from, to) => (to === SESSION_PATH ? Promise.reject(new Error("EBUSY")) : original(from, to));
    const outcome = await repairSessionFolders(h.deps);
    assert.deepEqual(outcome, { kind: "left", reason: "EBUSY" });
    assert.equal(h.files.get(SESSION_PATH), sessionText());
    assert.equal(h.files.has(`${SESSION_PATH}.navigator-repair.tmp`), false);
  });
});
