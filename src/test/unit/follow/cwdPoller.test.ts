import assert from "node:assert/strict";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import type { Clock } from "../../../follow/controller";
import { CwdPoller, MIN_POLL_MS } from "../../../follow/cwdPoller";
import { routeHerdrEvent } from "../../../follow/routeEvent";
import type { CwdSource } from "../../../follow/resolveTarget";
import { pollIntervalMs } from "../../../follow/pollGate";

class FakeClock implements Clock {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private now = 0;

  get time(): number {
    return this.now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, { at, fn }] of [...this.timers]) {
      if (at > this.now) continue;
      this.timers.delete(id);
      fn();
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

function pane(id: string, focused: boolean, cwd: string, foreground?: string): PaneInfo {
  return { pane_id: id, terminal_id: "t", workspace_id: "w", tab_id: "tab", focused, cwd, foreground_cwd: foreground };
}

interface Harness {
  poller: CwdPoller;
  clock: FakeClock;
  // `fetches` counts every poll request (snapshot or pane.get); the two counters split it.
  state: { focused: string; panes: PaneInfo[]; fetches: number; snapshots: number; paneGets: number; paneError: Error | null; changes: number; busy: boolean; active: boolean; hold: Promise<void> | null; live: string | null; probes: number };
}

function harness(cwdSource: CwdSource = "auto"): Harness {
  const clock = new FakeClock();
  const state: Harness["state"] = {
    focused: "p1",
    panes: [pane("p1", true, "/a"), pane("p2", false, "/x")],
    fetches: 0,
    snapshots: 0,
    paneGets: 0,
    paneError: null,
    changes: 0,
    busy: false,
    active: true,
    hold: null,
    live: null,
    probes: 0,
  };
  const poller = new CwdPoller({
    platform: "linux",
    fetchSnapshot: async (): Promise<SessionSnapshot> => {
      state.fetches += 1;
      state.snapshots += 1;
      if (state.hold) await state.hold;
      return {
        focused_workspace_id: "w",
        focused_tab_id: "tab",
        focused_pane_id: state.focused,
        panes: state.panes,
        tabs: [],
        workspaces: [],
      };
    },
    fetchPane: async (paneId): Promise<PaneInfo> => {
      state.fetches += 1;
      state.paneGets += 1;
      if (state.hold) await state.hold;
      if (state.paneError) throw state.paneError;
      const found = state.panes.find((candidate) => candidate.pane_id === paneId);
      if (!found) throw new Error("herdr pane.get failed: pane_not_found");
      return found;
    },
    getCwdSource: () => cwdSource,
    probeLive: async (): Promise<string | null> => {
      state.probes += 1;
      return state.live;
    },
    isBusy: () => state.busy,
    isActive: () => state.active,
    onChange: () => {
      state.changes += 1;
    },
    clock,
    now: () => clock.time,
  });
  return { poller, clock, state };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function tick(h: Harness, ms = 1000): Promise<void> {
  h.clock.advance(ms);
  await settle();
}

describe("CwdPoller", () => {
  it("records a baseline from one snapshot, then polls the focused pane with pane.get and follows each cwd change in it once; the timer never probes", async () => {
    const h = harness();
    // A probe answer is available, yet a timer tick must not spawn the probe: that would be a heavier poll.
    h.state.live = "/elsewhere";
    h.poller.start(1000);
    await tick(h);
    assert.deepEqual([h.state.snapshots, h.state.changes], [1, 0]);
    h.state.panes = [pane("p1", true, "/a"), pane("p2", false, "/y")];
    await tick(h);
    assert.equal(h.state.changes, 0, "an unfocused pane is ignored");
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/y")];
    await tick(h);
    await tick(h);
    assert.equal(h.state.changes, 1);
    assert.deepEqual([h.state.snapshots, h.state.paneGets, h.state.probes], [1, 3, 0]);
  });

  it("a pane_updated after a focus cycle's snapshot polls at once and follows the cd, also one herdr reports at the stale spawn cwd; recorder events never reach the follow controller", async () => {
    const h = harness();
    const routed = { focus: 0, record: 0 };
    const route = (event: string): void =>
      routeHerdrEvent(event, { pollNow: () => h.poller.pollNow(), record: () => void routed.record++, onFocusEvent: () => void routed.focus++ });
    h.poller.start(1000);
    await tick(h);
    // Focus moved to p2; the follow cycle's snapshot saw /x, then the user cd'd to /x/new.
    h.state.focused = "p2";
    h.state.panes = [pane("p1", false, "/a"), pane("p2", true, "/x/new")];
    h.poller.observe({
      focused_workspace_id: "w",
      focused_tab_id: "tab",
      focused_pane_id: "p2",
      panes: [pane("p1", false, "/a"), pane("p2", true, "/x")],
      tabs: [],
      workspaces: [],
    });
    route("pane_updated");
    // Well before the 1000 ms interval: only the pollNow throttle delays it.
    await tick(h, MIN_POLL_MS);
    assert.equal(h.state.changes, 1);

    // A close is not a focus change: following it would re-run the folder switch for nothing.
    for (const event of ["pane_closed", "pane_exited", "pane_moved", "tab_closed", "workspace_closed"]) route(event);
    // A focus change is also recorded: the pane left behind may have changed folder without an event.
    route("pane_focused");
    assert.deepEqual(routed, { focus: 1, record: 7 });

    // Git Bash without OSC 7: herdr keeps reporting /x/new; only the probe sees the stock prompt's cd behind the title push.
    const titlePush = async (live: string): Promise<void> => {
      h.state.live = live;
      route("pane_updated");
      await tick(h, MIN_POLL_MS);
    };
    await titlePush("/x/live");
    await titlePush("/x/live");
    await titlePush("/x/other");
    assert.deepEqual([h.state.changes, h.state.probes], [3, 4], "each event probes once; only a moved live folder follows");
    h.state.panes = [pane("p1", false, "/a"), { ...pane("p2", true, "/x/new"), agent: "claude" }];
    await titlePush("/x/agent");
    assert.deepEqual([h.state.changes, h.state.probes], [3, 4], "an agent's title pushes spawn no probe");
  });
});

describe("pollIntervalMs", () => {
  it("polls only while connected and auto-following in a hosting window, or an undetectable one the user confirmed", () => {
    const base = { connected: true, autoFollow: true, host: "yes", confirmedHere: undefined, cwdPollMs: 1000 } as const;
    assert.equal(pollIntervalMs(base), 1000);
    assert.equal(pollIntervalMs({ ...base, host: "no" }), 0);
    assert.equal(pollIntervalMs({ ...base, connected: false }), 0);
    assert.equal(pollIntervalMs({ ...base, autoFollow: false }), 0);
    assert.equal(pollIntervalMs({ ...base, cwdPollMs: 0 }), 0);
    assert.equal(pollIntervalMs({ ...base, host: "unknown" }), 0);
    assert.equal(pollIntervalMs({ ...base, host: "unknown", confirmedHere: true }), 1000);
  });
});
