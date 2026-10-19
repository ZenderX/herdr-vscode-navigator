import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { TerminalLocation } from "vscode";
import type { SessionSnapshot } from "../../../herdr";
import type { HostState } from "../../../hosting";
import { activateNavigator, applyFolderPlan } from "../../../follow/applyFolderPlan";
import { planFolders } from "../../../follow/planFolders";
import type { NavigatorLease } from "../../../launch/navigatorLease";
import type { WindowKind } from "../../../launch/planAutoLaunch";
import { empty, readRecord } from "../../../launch/sessionState";
import type { SessionRecord } from "../../../launch/sessionState";
import { AutoLaunch, SESSION_KEY, sessionMemento } from "../../../vscode/autoLaunch";
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
  state: { isInteractedWith: boolean };
  constructor(
    public name: string,
    interacted = false,
  ) {
    this.state = { isInteractedWith: interacted };
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
  focused: string[];
  rescans: HostState[];
  /** Non-forced (cache-allowed) hosting requests. */
  rechecks: HostState[];
  snapshot: { value: SessionSnapshot };
  /** Pids the fake process probe reports as running. */
  alive: Set<number>;
  setEnabled: (value: boolean) => void;
  setRescan: (state: HostState) => void;
  /** Makes later rescans wait until the returned release is called. */
  holdRescan: () => () => void;
  leaseOnDisk: NavigatorLease | undefined;
  converted: string[];
  migrated: number;
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
  let rescanState = options.rescanState ?? "no";
  let gate: Promise<void> | undefined;
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
      return createdTerminal;
    },
    editorLocation: EDITOR,
    resolveHerdr: () => Promise.resolve("herdrPath" in options ? options.herdrPath : "C:\\bin\\herdr.exe"),
    rescan: async () => {
      rescans.push(rescanState);
      await gate;
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
  h.converted = [];
  h.migrated = 0;
  h.auto = new AutoLaunch(deps);
  h.setEnabled = (value) => {
    enabled = value;
  };
  h.holdRescan = () => {
    let release = (): void => undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  h.setRescan = (state) => {
    rescanState = state;
  };
  return h;
}

const stored = (h: Harness): SessionRecord => h.store.get(SESSION_KEY) as SessionRecord;

describe("AutoLaunch decision", () => {
  it("waits for the settle window and the first hosting sweep", async () => {
    const h = harness(record());
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1400);
    assert.equal(h.created.length, 0);
    await h.clock.advance(200);
    assert.equal(h.created.length, 1);
  });

  it("does not decide on the settle window alone", async () => {
    const h = harness(record());
    h.auto.start();
    await h.clock.advance(5000);
    assert.equal(h.created.length, 0);
    await h.auto.onHosting("no");
    assert.equal(h.created.length, 1);
  });

  it("restarts the settle window when a terminal opens", async () => {
    const h = harness(record());
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1000);
    h.auto.onTerminalOpened(new FakeTerminal("herdr"));
    await h.auto.onHosting("no");
    await h.clock.advance(1000);
    assert.equal(h.created.length, 0);
    await h.clock.advance(600);
    assert.equal(h.created.length, 1);
    assert.ok(h.logs.some((line) => line === "auto-launch: terminal seen herdr interacted=false at +1000ms"));
  });

  it("does not decide on a hosting result that predates a revived terminal", async () => {
    const revived = new FakeTerminal("herdr");
    const h = harness(record(), { terminals: [revived] });
    h.auto.start();
    await h.auto.onHosting("no");
    h.auto.onTerminalOpened(revived);
    await h.clock.advance(5000);
    assert.equal(h.created.length, 0);
    assert.equal(revived.shown, 0);
    assert.deepEqual(revived.sent, []);
    await h.auto.onHosting("yes");
    assert.ok(h.logs.includes("auto-launch: none already-hosting"));
    assert.equal(h.created.length, 0);
    assert.deepEqual(revived.sent, []);
  });

  it("reuses a revived untouched herdr tab without creating one", async () => {
    const revived = new FakeTerminal("herdr");
    const h = harness(record(), { terminals: [new FakeTerminal("bash"), revived] });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    assert.equal(h.created.length, 0);
    assert.equal(revived.shown, 1);
    assert.deepEqual(revived.sent, [["herdr", true]]);
  });

  for (const [platform, lastFolder, cwd] of [
    ["win32", "C:\\proj\\", "C:\\proj"],
    ["linux", "/home/u/proj/", "/home/u/proj"],
    ["darwin", "/Users/u/proj/", "/Users/u/proj"],
  ] as const) {
    it(`creates an editor-area terminal named herdr with the saved cwd and no shellPath on ${platform}`, async () => {
      const h = harness(record({ lastFolder }), { terminals: [new FakeTerminal("herdr", true)], platform });
      h.auto.start();
      await h.auto.onHosting("no");
      await h.clock.advance(1600);
      assert.deepEqual(h.created, [{ name: "herdr", location: EDITOR, cwd }]);
      assert.deepEqual(Object.keys(h.created[0] ?? {}).sort(), ["cwd", "location", "name"]);
      assert.deepEqual(h.createdTerminal.sent, [["herdr", true]]);
    });
  }

  it("logs that hosting was unknown when the first sweep could not tell", async () => {
    const h = harness(record());
    h.auto.start();
    await h.auto.onHosting("unknown");
    await h.clock.advance(1600);
    assert.ok(h.logs.includes("auto-launch: none already-hosting (hosting unknown)"));
  });

  it("logs herdr-missing and creates nothing", async () => {
    const h = harness(record(), { herdrPath: undefined });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    assert.equal(h.created.length, 0);
    assert.ok(h.logs.includes("auto-launch: none herdr-missing"));
  });

  it("creates nothing when the setting is off", async () => {
    const h = harness(record());
    h.setEnabled(false);
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    assert.equal(h.created.length, 0);
    assert.ok(h.logs.includes("auto-launch: none disabled"));
  });

  it("creates nothing when herdr was not running or is already hosted", async () => {
    const quit = harness(record({ herdrWasRunning: false }));
    quit.auto.start();
    await quit.auto.onHosting("no");
    await quit.clock.advance(1600);
    assert.equal(quit.created.length, 0);

    const hosted = harness(record());
    hosted.auto.start();
    await hosted.auto.onHosting("yes");
    await hosted.clock.advance(1600);
    assert.equal(hosted.created.length, 0);
  });
});

describe("AutoLaunch hosting loss", () => {
  it("keeps herdrWasRunning after a Shutdown terminal close", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    assert.equal(stored(h).herdrWasRunning, true);
    h.auto.onTerminalClosed("shutdown");
    await h.auto.onHosting("no");
    await h.clock.advance(10_000);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("records herdr-exited only after the confirming rescan", async () => {
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
  });

  it("does not record a loss when herdr is back at the confirming rescan", async () => {
    const h = harness(undefined, { rescanState: "yes" });
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    await h.clock.advance(5100);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("does not record a loss when the confirming rescan is unknown", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    h.setRescan("unknown");
    await h.clock.advance(5100);
    assert.deepEqual(h.rescans, ["unknown"]);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("still records herdr-exited when a later confirming rescan is clear after an unknown one", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    h.setRescan("unknown");
    await h.clock.advance(5100);
    assert.equal(stored(h).herdrWasRunning, true);
    h.setRescan("no");
    await h.clock.advance(5000);
    assert.deepEqual(h.rescans, ["unknown", "no"]);
    assert.equal(stored(h).herdrWasRunning, false);
  });

  it("stops retrying an unknown confirmation after three retries and leaves the record", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    h.setRescan("unknown");
    await h.clock.advance(60_000);
    assert.equal(h.rescans.length, 4);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("does not record a loss when herdr returns during the unknown retries", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    h.setRescan("unknown");
    await h.clock.advance(5100);
    h.setRescan("yes");
    await h.clock.advance(5000);
    h.setRescan("no");
    await h.clock.advance(30_000);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("bounds scans when the watched client is dead and every scan is unknown", async () => {
    const h = harness(undefined);
    h.alive.add(7);
    h.auto.start();
    await h.auto.onHosting("yes", [7]);
    h.alive.delete(7);
    h.setRescan("unknown");
    await h.clock.advance(120_000);
    assert.equal(h.rescans.length, 1);
    assert.equal(h.rechecks.length, 3);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("logs one line when the record changes and none for an unchanged write", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("yes");
    assert.deepEqual(h.logs.filter((l) => l.includes("record herdrWasRunning")), ["auto-launch: record herdrWasRunning=true (hostingSeen)"]);
    await h.auto.onHosting("no");
    await h.clock.advance(5100);
    assert.ok(h.logs.includes("auto-launch: record herdrWasRunning=false (hostingLost herdr-exited)"));
  });

  it("records herdr-exited after a disconnect with the terminal still open", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHerdrDisconnected();
    assert.equal(stored(h).herdrWasRunning, true);
    await h.clock.advance(5100);
    assert.deepEqual(h.rescans, ["no", "no"]);
    assert.equal(stored(h).herdrWasRunning, false);
  });

  it("records herdr-exited when the client process ends while the terminal stays open", async () => {
    const h = harness(undefined);
    h.alive.add(4242);
    h.auto.start();
    await h.auto.onHosting("yes", [4242]);
    await h.clock.advance(10_000);
    assert.deepEqual(h.rescans, []);
    h.alive.delete(4242);
    await h.clock.advance(2100);
    assert.deepEqual(h.rescans, ["no"]);
    assert.equal(stored(h).herdrWasRunning, true);
    await h.clock.advance(5100);
    assert.deepEqual(h.rescans, ["no", "no"]);
    assert.equal(stored(h).herdrWasRunning, false);
  });

  it("keeps watching the last known client through an unknown scan", async () => {
    const h = harness(undefined);
    h.alive.add(4242);
    h.auto.start();
    await h.auto.onHosting("yes", [4242]);
    await h.auto.onHosting("unknown");
    h.alive.delete(4242);
    await h.clock.advance(2100);
    assert.deepEqual(h.rescans, ["no"]);
    await h.clock.advance(5100);
    assert.equal(stored(h).herdrWasRunning, false);
  });

  it("sees herdr again after a detach and re-attach in the same terminal", async () => {
    const h = harness(undefined);
    h.alive.add(1);
    h.auto.start();
    await h.auto.onHosting("yes", [1]);
    h.alive.delete(1);
    await h.clock.advance(2100);
    await h.clock.advance(5100);
    assert.equal(stored(h).herdrWasRunning, false);
    await h.auto.onHosting("yes", [2]);
    assert.equal(stored(h).herdrWasRunning, true);
    await h.auto.observeSnapshot(h.snapshot.value);
    assert.equal(stored(h).lastSpaceLabel, "alpha");
  });

  it("keeps watching while any tracked client is alive", async () => {
    const h = harness(undefined);
    h.alive.add(2);
    h.auto.start();
    await h.auto.onHosting("yes", [1, 2]);
    await h.clock.advance(10_000);
    assert.deepEqual(h.rescans, []);
  });

  it("keeps herdrWasRunning when the client dies during a VS Code shutdown", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes", [4242]);
    h.auto.onTerminalClosed("shutdown");
    await h.clock.advance(10_000);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("keeps herdrWasRunning when a Shutdown close arrives during the confirm window", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHerdrDisconnected();
    h.auto.onTerminalClosed("shutdown");
    await h.clock.advance(5000);
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("ignores a disconnect while this window is not hosting", async () => {
    const h = harness(undefined);
    await h.auto.onHerdrDisconnected();
    assert.deepEqual(h.rescans, []);
  });

  it("records a user terminal close immediately", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    h.auto.onTerminalClosed("user");
    await h.auto.onHosting("no");
    assert.equal(stored(h).herdrWasRunning, false);
  });

  it("maps VS Code exit reasons: user clears the flag, shutdown and anything else keep it", async () => {
    const outcome = async (reason: unknown): Promise<boolean> => {
      const h = harness(undefined);
      h.auto.start();
      await h.auto.onHosting("yes");
      h.auto.onTerminalExited(reason);
      await h.auto.onHosting("no");
      await h.clock.advance(5000);
      return stored(h).herdrWasRunning;
    };
    assert.equal(await outcome("user-reason"), false);
    assert.equal(await outcome("shutdown-reason"), true);
    assert.equal(await outcome(undefined), true);
  });

  it("treats an unattributed close as unknown and keeps the flag", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    h.auto.onTerminalClosed("other");
    await h.auto.onHosting("no");
    await h.clock.advance(5000);
    assert.equal(stored(h).herdrWasRunning, true);
  });
});

describe("AutoLaunch space restore", () => {
  it("focuses the id found by label once herdr is hosted", async () => {
    const h = harness(record({ lastSpaceLabel: "beta", lastFolder: "C:\\proj" }), { rescanState: "yes" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    assert.equal(h.created.length, 1);
    await h.clock.advance(1100);
    assert.deepEqual(h.focused, ["w2"]);
  });

  it("does not focus when no label matches", async () => {
    const h = harness(record({ lastSpaceLabel: "gone" }), { rescanState: "yes" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    await h.clock.advance(1100);
    assert.deepEqual(h.focused, []);
    assert.ok(h.logs.some((line) => line.includes('space "gone" not found')));
  });

  it("gives up after the bounded wait when herdr never appears", async () => {
    const h = harness(record({ lastSpaceLabel: "beta" }), { rescanState: "no" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    await h.clock.advance(16_000);
    assert.deepEqual(h.focused, []);
    assert.ok(h.logs.some((line) => line.includes("gave up focusing")));
  });
});

describe("AutoLaunch dispose", () => {
  it("does not record herdr-exited when disposed while the confirming rescan is pending", async () => {
    const h = harness(undefined);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.auto.onHosting("no");
    const release = h.holdRescan();
    await h.clock.advance(5100);
    assert.deepEqual(h.rescans, ["no"]);
    h.auto.dispose();
    release();
    await flush();
    assert.equal(stored(h).herdrWasRunning, true);
  });

  it("schedules and calls nothing further when disposed during a pending restore attempt", async () => {
    const h = harness(record({ lastSpaceLabel: "beta" }), { rescanState: "no" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    h.auto.dispose();
    await h.clock.advance(30_000);
    assert.deepEqual(h.rescans, []);
    assert.deepEqual(h.focused, []);
  });

  it("does not re-arm the restore timer when disposed while an attempt awaits its rescan", async () => {
    const h = harness(record({ lastSpaceLabel: "beta" }), { rescanState: "no" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    const release = h.holdRescan();
    await h.clock.advance(1000);
    assert.deepEqual(h.rescans, ["no"]);
    h.auto.dispose();
    release();
    await flush();
    await h.clock.advance(30_000);
    assert.deepEqual(h.rescans, ["no"]);
    assert.deepEqual(h.focused, []);
  });
});

describe("AutoLaunch observeSnapshot", () => {
  it("records the focused space and herdr-format cwd only while hosting", async () => {
    const h = harness(undefined);
    await h.auto.observeSnapshot(h.snapshot.value);
    assert.equal(h.store.has(SESSION_KEY), false);
    await h.auto.onHosting("yes");
    await h.auto.observeSnapshot(h.snapshot.value);
    assert.equal(stored(h).lastSpaceLabel, "alpha");
    assert.equal(stored(h).lastFolder, "C:\\proj");
  });
});

describe("AutoLaunch takeover wiring", () => {
  const plain = { kind: "single-folder", folder: "C:\\other" } as const;

  it("converts a plain window after the grace delay when the previous session ran a navigator and no lease exists", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    await h.clock.advance(2900);
    assert.deepEqual(h.converted, []);
    await h.clock.advance(200);
    assert.deepEqual(h.converted, ["C:\\other"]);
    assert.equal(stored(h).pendingTakeoverFolder, "C:\\other");
    assert.ok(h.logs.includes("auto-launch: convert-explicit folder=C:\\other"));
  });

  it("does not convert when a navigator of this launch holds a live lease, even one written during the grace delay", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    await h.clock.advance(1000);
    h.leaseOnDisk = { launchId: LAUNCH, writtenAt: h.clock.now(), folder: "C:\\proj" };
    await h.clock.advance(2500);
    assert.deepEqual(h.converted, []);
    assert.ok(h.logs.includes("auto-launch: none navigator-alive"));
    assert.equal(stored(h).pendingTakeoverFolder, undefined);
  });

  it("does not convert when the previous session had no navigator", async () => {
    const h = harness(record({ herdrWasRunning: false }), plain);
    h.auto.start();
    await h.clock.advance(4000);
    assert.deepEqual(h.converted, []);
    assert.ok(h.logs.includes("auto-launch: none not-navigator"));
  });

  it("leaves a window to the other window's takeover when one is already pending", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    h.store.set(SESSION_KEY, record({ launchId: OLD_LAUNCH, pendingTakeoverFolder: "C:\\first", updatedAt: 0 }));
    await h.clock.advance(4000);
    assert.deepEqual(h.converted, []);
    assert.ok(h.logs.includes("auto-launch: none takeover-pending"));
  });

  it("never converts a plain window that hosts herdr through the explicit path", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    await h.auto.onHosting("yes");
    await h.clock.advance(4000);
    assert.deepEqual(h.converted, []);
  });

  it("writes the lease as the first step of a saved navigator's start", () => {
    const h = harness(record(), { folder: "C:\\proj" });
    h.auto.start();
    assert.deepEqual(h.leaseOnDisk, { launchId: LAUNCH, writtenAt: 0, folder: "C:\\proj" });
  });

  it("keeps the pending takeover of a slow-shutting-down converting window for the reloaded navigator", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }), plain);
    h.auto.start();
    await h.clock.advance(3100);
    await h.clock.advance(30_000);
    assert.equal(stored(h).pendingTakeoverFolder, "C:\\other");
    h.auto.dispose();

    const navigator = harness(stored(h), { folder: "C:\\other" });
    navigator.clock.time = h.clock.now();
    navigator.auto.start();
    await navigator.auto.onHosting("no");
    await navigator.clock.advance(1600);
    assert.equal(navigator.created[0]?.cwd, "C:\\other");
    assert.equal(stored(navigator).pendingTakeoverFolder, undefined);
  });

  it("keeps a saved navigator's lease fresh while it never reports hosting", async () => {
    const h = harness(record(), { folder: "C:\\proj" });
    h.auto.start();
    await h.auto.onHosting("unknown");
    await h.clock.advance(120_000);
    assert.equal(h.clock.now() - (h.leaseOnDisk?.writtenAt ?? 0) < 60_000, true);
  });

  it("stops refreshing the lease once disposed", async () => {
    const h = harness(record(), { folder: "C:\\proj" });
    h.auto.start();
    h.auto.dispose();
    await h.clock.advance(120_000);
    assert.equal(h.leaseOnDisk?.writtenAt, 0);
  });

  it("does not write a lease from a plain window", () => {
    const h = harness(record(), plain);
    h.auto.start();
    assert.equal(h.leaseOnDisk, undefined);
  });

  it("migrates a legacy untitled navigator instead of launching herdr in it", async () => {
    const h = harness(record(), { kind: "navigator-untitled", folder: "C:\\proj" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(2000);
    assert.equal(h.migrated, 1);
    assert.equal(h.created.length, 0);
    assert.equal(stored(h).pendingTakeoverFolder, "C:\\proj");
    assert.ok(h.logs.includes("auto-launch: legacy-untitled"));
  });

  it("launches herdr focused on the pending takeover folder once, then clears it", async () => {
    const h = harness(record({ pendingTakeoverFolder: "C:\\proj", lastFolder: "C:\\elsewhere", lastSpaceLabel: "beta" }), { folder: "C:\\proj" });
    h.auto.start();
    await h.auto.onHosting("no");
    await h.clock.advance(1600);
    assert.equal(h.created[0]?.cwd, "C:\\proj");
    assert.equal(stored(h).pendingTakeoverFolder, undefined);
    assert.ok(h.logs.includes("auto-launch: create herdr cwd=C:\\proj focus=C:\\proj"));
    h.setRescan("yes");
    await h.clock.advance(1100);
    assert.deepEqual(h.focused, ["w1"]);
  });

  it("records a pending takeover before a hosting window converts, and marks the navigator as running", async () => {
    const h = harness(undefined, plain);
    await h.auto.beginHostingConversion("C:\\other");
    assert.equal(stored(h).pendingTakeoverFolder, "C:\\other");
    assert.equal(stored(h).herdrWasRunning, true);
    assert.equal(stored(h).launchId, LAUNCH);
    assert.ok(h.logs.includes("auto-launch: convert-hosting folder=C:\\other"));
  });

  describe("takeover through a kept navigator file", () => {
    const ANCHOR = "C:\\storage\\anchor";
    const STALE = "C:\\work\\stale";
    const TARGET = "C:\\work\\target";
    const never = (): void => undefined;

    // Fakes a reopened window: the folders are what the kept file holds, and every change is logged in order.
    const navigatorWindow = (folders: string[], order: string[]) => ({
      openFolders: () => folders,
      convert: () => Promise.resolve(true),
      updateFolders: (_kind: string, start: number, deleteCount: number, add: string[]) => {
        folders.splice(start, deleteCount, ...add);
        order.push(`replace ${add.join()}`);
        return Promise.resolve(true);
      },
    });

    const activate = async (h: Harness, folders: string[], order: string[]): Promise<string[]> => {
      const tracked: string[] = [];
      const rec = readRecord(h.store.get(SESSION_KEY));
      await activateNavigator(
        {
          takeover: { folder: rec.pendingTakeoverFolder, at: rec.updatedAt },
          savedNavigator: true,
          now: h.clock.now(),
          maxAgeMs: 120_000,
          resume: (slot) => Promise.resolve(void tracked.push(slot)),
        },
        navigatorWindow(folders, order),
        "win32",
        never,
      );
      return tracked;
    };

    it("moves a non-hosting window's target into slot 1 of the kept file without marking herdr as running", async () => {
      const origin = harness(undefined, plain);
      const plan = planFolders({ folders: [{ path: "C:\\other" }], trackedPath: null, anchorPath: ANCHOR, target: TARGET, isMultiRoot: false, platform: "win32" });
      const order: string[] = [];
      const folders = [ANCHOR, STALE];
      const effects = { ...navigatorWindow(folders, order), openFolders: () => ["C:\\other"], convert: () => Promise.resolve(true) };
      const handoff = { hostsHerdr: () => false, beginHostingConversion: (f: string) => origin.auto.beginHostingConversion(f), recordTakeover: (f: string) => origin.auto.recordTakeover(f) };
      assert.equal(await applyFolderPlan(plan, effects, handoff, "win32", never), true);
      assert.equal(stored(origin).herdrWasRunning, false);
      assert.equal(stored(origin).launchId, undefined);

      const navigator = harness(stored(origin));
      assert.deepEqual(await activate(navigator, folders, order), [TARGET]);
      assert.deepEqual(order, [`replace ${TARGET}`]);
      assert.deepEqual(folders, [ANCHOR, TARGET]);
    });

    it("replaces slot 1 first, then auto-launch consumes the takeover once", async () => {
      const h = harness(record({ pendingTakeoverFolder: TARGET, updatedAt: 0 }), { folder: TARGET });
      const order: string[] = [];
      const folders = [ANCHOR, STALE];
      assert.deepEqual(await activate(h, folders, order), [TARGET]);
      assert.equal(stored(h).pendingTakeoverFolder, TARGET);
      h.auto.start();
      await h.auto.onHosting("no");
      await h.clock.advance(1600);
      assert.deepEqual(order, [`replace ${TARGET}`]);
      assert.equal(stored(h).pendingTakeoverFolder, undefined);
      assert.equal(h.logs.filter((line) => line.includes("(takeoverConsumed)")).length, 1);
    });

    it("tracks slot 1 and consumes the takeover without a change when it already holds the folder", async () => {
      const h = harness(record({ pendingTakeoverFolder: TARGET, updatedAt: 0 }), { folder: TARGET });
      const order: string[] = [];
      assert.deepEqual(await activate(h, [ANCHOR, TARGET], order), [TARGET]);
      h.auto.start();
      await h.auto.onHosting("no");
      await h.clock.advance(1600);
      assert.deepEqual(order, []);
      assert.equal(stored(h).pendingTakeoverFolder, undefined);
      assert.equal(h.logs.filter((line) => line.includes("(takeoverConsumed)")).length, 1);
    });
  });

  it("does not let a plain window read the navigator-scoped record left in its own workspaceState", async () => {
    const store = new Map<string, unknown>();
    const globalState = { get: (key: string) => store.get(key), update: (key: string, value: unknown) => Promise.resolve(void store.set(key, value)) };
    const workspaceState = new Map<string, unknown>([[SESSION_KEY, record({ launchId: OLD_LAUNCH })]]);
    const memento = (legacy: boolean): AutoLaunchDeps["memento"] => sessionMemento(globalState, workspaceState, () => legacy);
    assert.equal(memento(false).get(SESSION_KEY), undefined);
    assert.deepEqual(memento(true).get(SESSION_KEY), record({ launchId: OLD_LAUNCH }));
    store.set(SESSION_KEY, record());
    assert.deepEqual(memento(true).get(SESSION_KEY), record());
  });

  it("stamps the launch on hosting even when the previous launch already set the flag", async () => {
    const h = harness(record({ launchId: OLD_LAUNCH }));
    await h.auto.onHosting("yes");
    assert.equal(stored(h).launchId, LAUNCH);
  });
});
