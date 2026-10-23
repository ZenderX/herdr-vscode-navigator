import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { TerminalLocation } from "vscode";
import type { SessionSnapshot } from "../../../herdr";
import type { HostState } from "../../../hosting";
import type { NavigatorLease } from "../../../launch/navigatorLease";
import type { PluginState } from "../../../launch/pluginDetect";
import type { WindowKind } from "../../../launch/planAutoLaunch";
import { empty } from "../../../launch/sessionState";
import type { SessionRecord } from "../../../launch/sessionState";
import { AutoLaunch, SESSION_KEY } from "../../../vscode/autoLaunch";
import type { AutoLaunchDeps, AutoLaunchTerminal } from "../../../vscode/autoLaunch";

const EDITOR = 1 as TerminalLocation;
const LAUNCH = "launch-now";
const OLD_LAUNCH = "launch-before";
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeClock {
  time = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.push({ id: ++this.next, at: this.time + ms, fn });
    return this.next;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(({ id }) => id !== handle);
  }
  now(): number {
    return this.time;
  }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter(({ at }) => at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(({ id }) => id !== due.id);
      this.time = due.at;
      due.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

class FakeTerminal implements AutoLaunchTerminal {
  shown = 0;
  sent: Array<[string, boolean | undefined]> = [];
  disposed = false;
  state: { isInteractedWith: boolean };
  constructor(
    public name: string,
    interacted = false,
    public creationOptions?: object,
  ) {
    this.state = { isInteractedWith: interacted };
  }
  dispose(): void {
    this.disposed = true;
  }
  show(): void {
    this.shown++;
  }
  sendText(text: string, shouldExecute?: boolean): void {
    this.sent.push([text, shouldExecute]);
  }
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...empty(), herdrWasRunning: true, updatedAt: 1, ...overrides };
}

interface Harness {
  auto: AutoLaunch;
  clock: FakeClock;
  store: Map<string, unknown>;
  logs: string[];
  terminals: FakeTerminal[];
  created: Array<{ name: string; location: TerminalLocation; cwd?: string }>;
  createdTerminal: FakeTerminal;
  madeTerminals: FakeTerminal[];
  focused: string[];
  rescans: HostState[];
  /** Non-forced (cache-allowed) hosting requests. */
  rechecks: HostState[];
  snapshot: { value: SessionSnapshot };
  /** Pids the fake process probe reports as running. */
  alive: Set<number>;
  setEnabled: (value: boolean) => void;
  setPlugin: (state: PluginState) => void;
  pluginCalls: number;
  setRescan: (state: HostState) => void;
  leaseOnDisk: NavigatorLease | undefined;
  converted: string[];
  migrated: number;
  /** Makes later herdr lookups wait until the returned release is called, holding a launch in flight. */
  holdResolve: () => () => void;
  /** What the per-terminal process-tree scan reports; "no" when absent. */
  terminalHosting: Map<AutoLaunchTerminal, HostState>;
}

function harness(
  initial: SessionRecord | undefined,
  options: {
    terminals?: FakeTerminal[];
    herdrPath?: string;
    rescanState?: HostState;
    platform?: NodeJS.Platform;
    kind?: WindowKind;
    folder?: string;
    lease?: NavigatorLease;
    /** createTerminal returns a new terminal per call, recorded in `madeTerminals`. */
    distinctTerminals?: boolean;
    /** Whether the herdr server answers on the socket; defaults to stopped. */
    serverRunning?: boolean;
  } = {},
): Harness {
  const clock = new FakeClock();
  const store = new Map<string, unknown>();
  if (initial) store.set(SESSION_KEY, initial);
  const logs: string[] = [];
  const terminals = options.terminals ?? [];
  const created: Harness["created"] = [];
  const createdTerminal = new FakeTerminal("herdr");
  const focused: string[] = [];
  const snapshot = {
    value: {
      focused_workspace_id: "w1",
      focused_tab_id: null,
      focused_pane_id: "p1",
      panes: [{ pane_id: "p1", terminal_id: "t", workspace_id: "w1", tab_id: "x", focused: true, cwd: "C:\\proj" }],
      tabs: [],
      workspaces: [{ workspace_id: "w1", label: "alpha" }, { workspace_id: "w2", label: "beta" }],
    } as SessionSnapshot,
  };
  const rescans: HostState[] = [];
  const rechecks: HostState[] = [];
  let enabled = true;
  let pluginState: PluginState = "absent";
  let rescanState = options.rescanState ?? "no";
  let resolveGate: Promise<void> | undefined;
  const alive = new Set<number>();
  const h = { clock, store, logs, terminals, created, createdTerminal, focused, rescans, rechecks, snapshot, alive } as Harness;
  const deps: AutoLaunchDeps = {
    platform: options.platform ?? "win32",
    log: (_level, message) => void logs.push(message),
    clock,
    memento: { get: (key) => store.get(key), update: (key, value) => Promise.resolve(void store.set(key, value)) },
    enabled: () => enabled,
    isNavigator: () => true,
    terminals: () => terminals,
    createTerminal: (o) => {
      created.push(o);
      if (!options.distinctTerminals) return createdTerminal;
      const terminal = new FakeTerminal(o.name);
      h.madeTerminals.push(terminal);
      terminals.push(terminal);
      return terminal;
    },
    editorLocation: EDITOR,
    resolveHerdr: async () => {
      await resolveGate;
      return "herdrPath" in options ? options.herdrPath : "C:\\bin\\herdr.exe";
    },
    detectPlugin: () => {
      h.pluginCalls += 1;
      return Promise.resolve(pluginState);
    },
    terminalHostsHerdr: (terminal) => Promise.resolve(h.terminalHosting.get(terminal) ?? "no"),
    serverRunning: () => Promise.resolve(options.serverRunning ?? false),
    rescan: async () => {
      rescans.push(rescanState);
      await h.auto.onHosting(rescanState);
    },
    recheck: async () => {
      rechecks.push(rescanState);
      await h.auto.onHosting(rescanState);
    },
    isAlive: (pid) => alive.has(pid),
    exitReasons: { shutdown: "shutdown-reason", user: "user-reason" },
    client: () => ({ snapshot: () => Promise.resolve(h.snapshot.value), focusWorkspace: (id) => Promise.resolve(void focused.push(id)) }),
    launchId: LAUNCH,
    windowKind: () => options.kind ?? "navigator-saved",
    windowFolder: () => options.folder,
    lease: { read: () => h.leaseOnDisk, write: (lease) => void (h.leaseOnDisk = lease) },
    convertWindow: (folder) => Promise.resolve(void h.converted.push(folder)),
    migrateLegacy: () => Promise.resolve(void (h.migrated += 1)),
  };
  h.leaseOnDisk = options.lease;
  h.madeTerminals = [];
  h.terminalHosting = new Map();
  h.holdResolve = () => {
    let release = (): void => undefined;
    resolveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  h.converted = [];
  h.migrated = 0;
  h.pluginCalls = 0;
  h.auto = new AutoLaunch(deps);
  h.setPlugin = (state) => {
    pluginState = state;
  };
  h.setEnabled = (value) => {
    enabled = value;
  };
  h.setRescan = (state) => {
    rescanState = state;
  };
  return h;
}

const stored = (h: Harness): SessionRecord => h.store.get(SESSION_KEY) as SessionRecord;

describe("AutoLaunch decision", () => {
  it("after the settle window and the first hosting sweep, creates one editor-area herdr terminal in the saved folder and runs herdr", async () => {
    const h = harness(record({ lastFolder: "C:\\proj\\" }), { terminals: [new FakeTerminal("herdr", true)] });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1400);
    assert.equal(h.created.length, 0);
    await h.clock.advance(200);
    assert.deepEqual(h.created, [{ name: "herdr", location: EDITOR, cwd: "C:\\proj" }]);
    assert.deepEqual(h.createdTerminal.sent, [["herdr", true]]);
  });

  describe("a revived herdr terminal arriving after the extension created its own", () => {
    async function createdHarness(): Promise<Harness> {
      const h = harness(record());
      h.auto.start();
      await h.auto.onHosting("no");
      await h.clock.advance(1600);
      assert.equal(h.created.length, 1);
      return h;
    }

    it("disposes an empty revived tab and keeps the one that ran herdr, but keeps a revived tab still running herdr or used by the user", async () => {
      const h = await createdHarness();
      const revived = new FakeTerminal("herdr", false, { name: "herdr" });
      h.auto.onTerminalOpened(revived);
      await flush();
      assert.equal(revived.disposed, true);
      assert.equal(h.createdTerminal.disposed, false);
      assert.deepEqual(h.createdTerminal.sent, [["herdr", true]]);
      assert.deepEqual(revived.sent, []);

      for (const [hosting, interacted] of [["yes", false], ["unknown", false], ["no", true]] as const) {
        const other = await createdHarness();
        const kept = new FakeTerminal("herdr", interacted);
        other.terminalHosting.set(kept, hosting);
        other.auto.onTerminalOpened(kept);
        await flush();
        assert.equal(kept.disposed, false, `${hosting} interacted=${interacted}`);
        assert.equal(other.createdTerminal.disposed, false);
      }
    });

    it("reconciles a revived tab that opened while the launch was held, so it is not launched twice", async () => {
      const h = harness(record(), { distinctTerminals: true });
      const release = h.holdResolve();
      h.auto.start();
      await h.auto.onHosting("no");
      await h.clock.advance(1600);
      const revived = new FakeTerminal("herdr");
      h.auto.onTerminalOpened(revived);
      await flush();
      assert.equal(revived.disposed, false);
      release();
      await flush();
      assert.equal(h.madeTerminals.length, 1);
      assert.equal(revived.disposed, true);
      assert.equal(h.madeTerminals[0]?.disposed, false);
    });
  });
});

describe("AutoLaunch hosting loss", () => {
  it("records herdr-exited only after the confirming rescan, but keeps herdrWasRunning across a VS Code shutdown close", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    assert.equal(stored(h).herdrWasRunning, true);
    await h.clock.advance(4900);
    assert.equal(stored(h).herdrWasRunning, true);
    await h.clock.advance(200);
    assert.deepEqual(h.rescans, ["no"]);
    assert.equal(stored(h).herdrWasRunning, false);

    const shutdown = harness(undefined);
    shutdown.auto.start();
    await shutdown.auto.onHosting("yes");
    shutdown.auto.onTerminalClosed("shutdown");
    await shutdown.auto.onHosting("no");
    await shutdown.clock.advance(10_000);
    assert.equal(stored(shutdown).herdrWasRunning, true);
  });
});

describe("AutoLaunch launchNow", () => {
  it("is busy during the settle window, so a click and auto-launch create one terminal", async () => {
    const h = harness(record(), { distinctTerminals: true });
    h.auto.start();
    await h.auto.onHosting("no");
    assert.equal(await h.auto.launchNow(), "busy");
    await h.clock.advance(1600);
    assert.equal(h.madeTerminals.length, 1);
    assert.deepEqual(h.madeTerminals[0]?.sent, [["herdr", true]]);
  });
});

describe("AutoLaunch re-focus", () => {
  const remembered = (): SessionRecord => record({ lastFolder: "C:\\proj", lastSpaceLabel: "beta" });

  it("re-focuses the remembered space only when the launch started herdr's server, keeping the current space when it attaches", async () => {
    const started = harness(remembered());
    assert.equal(await started.auto.launchNow(), "launched");
    started.setRescan("yes");
    await started.clock.advance(16_000);
    assert.deepEqual(started.focused, ["w2"]);

    const attached = harness(remembered(), { serverRunning: true });
    assert.equal(await attached.auto.launchNow(), "launched");
    attached.setRescan("yes");
    await attached.clock.advance(16_000);
    assert.deepEqual(attached.focused, []);
    assert.equal(attached.pluginCalls, 0);
  });

  it("leaves the re-focus to the herdr plugin when it is installed", async () => {
    const h = harness(remembered());
    h.setPlugin("present");
    assert.equal(await h.auto.launchNow(), "launched");
    h.setRescan("yes");
    await h.clock.advance(16_000);
    assert.equal(h.pluginCalls, 1);
    assert.deepEqual(h.focused, []);
  });
});

describe("AutoLaunch takeover wiring", () => {
  const plain = { kind: "single-folder", folder: "C:\\other" } as const;

  it("converts a plain window after the grace delay when the previous session ran a navigator, unless a navigator of this launch holds a live lease", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    await h.clock.advance(2900);
    assert.deepEqual(h.converted, []);
    await h.clock.advance(200);
    assert.deepEqual(h.converted, ["C:\\other"]);
    assert.equal(stored(h).pendingTakeoverFolder, "C:\\other");

    const alive = harness(record({ launchId: OLD_LAUNCH }), plain);
    alive.auto.start();
    await alive.clock.advance(1000);
    alive.leaseOnDisk = { launchId: LAUNCH, writtenAt: alive.clock.now(), folder: "C:\\proj" };
    await alive.clock.advance(2500);
    assert.deepEqual(alive.converted, []);
    assert.equal(stored(alive).pendingTakeoverFolder, undefined);
  });
});
