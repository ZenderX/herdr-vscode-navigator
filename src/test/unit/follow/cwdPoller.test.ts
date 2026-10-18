import assert from "node:assert/strict";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import type { Clock } from "../../../follow/controller";
import { CwdPoller, MIN_POLL_MS } from "../../../follow/cwdPoller";
import type { CwdSource } from "../../../follow/resolveTarget";
import { createHostState, pollIntervalMs } from "../../../follow/pollGate";
import { routeHerdrEvent } from "../../../follow/routeEvent";

class FakeClock implements Clock {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private now = 0;

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
  state: { focused: string; panes: PaneInfo[]; fetches: number; changes: number; busy: boolean; active: boolean; hold: Promise<void> | null };
}

function harness(cwdSource: CwdSource = "auto"): Harness {
  const clock = new FakeClock();
  const state: Harness["state"] = {
    focused: "p1",
    panes: [pane("p1", true, "/a"), pane("p2", false, "/x")],
    fetches: 0,
    changes: 0,
    busy: false,
    active: true,
    hold: null,
  };
  const poller = new CwdPoller({
    platform: "linux",
    fetchSnapshot: async (): Promise<SessionSnapshot> => {
      state.fetches += 1;
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
    getCwdSource: () => cwdSource,
    isBusy: () => state.busy,
    isActive: () => state.active,
    onChange: () => {
      state.changes += 1;
    },
    clock,
  });
  return { poller, clock, state };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function tick(h: Harness, ms = 1000): Promise<void> {
  h.clock.advance(ms);
  await settle();
}

describe("CwdPoller", () => {
  it("the first poll only records a baseline", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    assert.equal(h.state.fetches, 1);
    assert.equal(h.state.changes, 0);
  });

  it("a cwd change in the focused pane triggers exactly one follow", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 1);
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("prefers foreground_cwd over cwd, like the follow target", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [pane("p1", true, "/a", "/a/sub"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("a change in an unfocused pane does nothing", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [pane("p1", true, "/a"), pane("p2", false, "/y")];
    await tick(h);
    assert.equal(h.state.changes, 0);
  });

  it("an unchanged cwd (title-only update, trailing separator) triggers nothing", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [{ ...pane("p1", true, "/a/"), terminal_title: "new title" }, pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 0);
  });

  it("a focus change resets the baseline without triggering", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.focused = "p2";
    h.state.panes = [pane("p1", false, "/a"), pane("p2", true, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 0);
    h.state.panes = [pane("p1", false, "/a"), pane("p2", true, "/x/deeper")];
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("skips ticks while a follow cycle is in flight, then still notices the change", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.state.busy = true;
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.fetches, 1);
    assert.equal(h.state.changes, 0);
    h.state.busy = false;
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("never overlaps polls: a pollNow during an in-flight poll is ignored", async () => {
    const h = harness();
    h.poller.start(1000);
    let release: () => void = () => undefined;
    h.state.hold = new Promise<void>((resolve) => (release = resolve));
    h.clock.advance(1000);
    await settle();
    h.poller.pollNow();
    await settle();
    assert.equal(h.state.fetches, 1);
    release();
    await settle();
    assert.equal(h.clock.pending, 1);
  });

  it("pollNow runs a tick immediately and keeps a single timer", async () => {
    const h = harness();
    h.poller.start(1000);
    h.poller.pollNow();
    await settle();
    assert.equal(h.state.fetches, 1);
    assert.equal(h.clock.pending, 1);
  });

  it("an interval of 0 does not poll; small intervals are raised to the minimum", async () => {
    const h = harness();
    h.poller.start(0);
    assert.equal(h.clock.pending, 0);
    h.poller.pollNow();
    await settle();
    assert.equal(h.state.fetches, 0);
    h.poller.start(10);
    await tick(h, MIN_POLL_MS - 1);
    assert.equal(h.state.fetches, 0);
    await tick(h, 1);
    assert.equal(h.state.fetches, 1);
  });

  it("stops itself once no longer active and polls nothing more", async () => {
    const h = harness();
    h.poller.start(1000);
    h.state.active = false;
    await tick(h);
    assert.equal(h.state.fetches, 0);
    assert.equal(h.clock.pending, 0);
  });

  it("stop cancels the timer and drops the baseline", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.poller.stop();
    assert.equal(h.clock.pending, 0);
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/x")];
    h.poller.start(1000);
    await tick(h);
    assert.equal(h.state.changes, 0);
  });

  it("start with an unchanged interval does not reset the timer or baseline", async () => {
    const h = harness();
    h.poller.start(1000);
    await tick(h);
    h.poller.start(1000);
    assert.equal(h.clock.pending, 1);
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("a failed snapshot is survived and polling continues", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const poller = new CwdPoller({
      platform: "linux",
      fetchSnapshot: async () => {
        calls += 1;
        throw new Error("down");
      },
      getCwdSource: () => "auto",
      isBusy: () => false,
      isActive: () => true,
      onChange: () => undefined,
      clock,
    });
    poller.start(1000);
    clock.advance(1000);
    await settle();
    clock.advance(1000);
    await settle();
    assert.equal(calls, 2);
  });

  it("a pane_updated event runs exactly one immediate poll, never the focus path, and a cwd change seen by it follows once", async () => {
    const h = harness();
    h.poller.start(1000);
    let focusCalls = 0;
    const routes = { pollNow: () => h.poller.pollNow(), onFocusEvent: () => (focusCalls += 1) };
    routeHerdrEvent("pane_updated", routes);
    await settle();
    assert.equal(h.state.fetches, 1);
    assert.equal(h.state.changes, 0);
    h.state.panes = [pane("p1", true, "/a/b"), pane("p2", false, "/x")];
    routeHerdrEvent("pane_updated", routes);
    await settle();
    assert.equal(h.state.fetches, 2);
    assert.equal(h.state.changes, 1);
    assert.equal(focusCalls, 0);
  });

  it("workspace_created polls; focus events reach the focus path without polling", async () => {
    const h = harness();
    h.poller.start(1000);
    let focusCalls = 0;
    const routes = { pollNow: () => h.poller.pollNow(), onFocusEvent: () => (focusCalls += 1) };
    routeHerdrEvent("workspace_created", routes);
    await settle();
    assert.equal(h.state.fetches, 1);
    routeHerdrEvent("pane_focused", routes);
    await settle();
    assert.equal(focusCalls, 1);
    assert.equal(h.state.fetches, 1);
  });

  it("cwdSource pane compares cwd even when foreground_cwd is set and unchanged", async () => {
    const h = harness("pane");
    h.state.panes = [pane("p1", true, "/a", "/fg"), pane("p2", false, "/x")];
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [pane("p1", true, "/a/b", "/fg"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 1);
  });

  it("cwdSource foreground ignores a cwd-only change", async () => {
    const h = harness("foreground");
    h.state.panes = [pane("p1", true, "/a", "/fg"), pane("p2", false, "/x")];
    h.poller.start(1000);
    await tick(h);
    h.state.panes = [pane("p1", true, "/a/b", "/fg"), pane("p2", false, "/x")];
    await tick(h);
    assert.equal(h.state.changes, 0);
  });

  it("stop then start during an in-flight poll does not start a second fetch", async () => {
    const h = harness();
    h.poller.start(1000);
    let release: () => void = () => undefined;
    h.state.hold = new Promise<void>((resolve) => (release = resolve));
    await tick(h);
    assert.equal(h.state.fetches, 1);
    h.poller.stop();
    h.poller.start(1000);
    await tick(h);
    assert.equal(h.state.fetches, 1);
    release();
    await settle();
    assert.equal(h.clock.pending, 1);
    await tick(h);
    assert.equal(h.state.fetches, 2);
  });

  it("a cd made after a focus cycle's snapshot but before the first poll is followed", async () => {
    const h = harness();
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
    await tick(h);
    assert.equal(h.state.changes, 1);
  });
});

describe("pollIntervalMs", () => {
  const base = { connected: true, autoFollow: true, host: "yes", confirmedHere: undefined, cwdPollMs: 1000 } as const;

  it("a hosting flip no -> yes starts polling and yes -> no stops it", () => {
    assert.equal(pollIntervalMs({ ...base, host: "no" }), 0);
    assert.equal(pollIntervalMs(base), 1000);
    assert.equal(pollIntervalMs({ ...base, host: "no" }), 0);
  });

  it("needs a connection and auto-follow", () => {
    assert.equal(pollIntervalMs({ ...base, connected: false }), 0);
    assert.equal(pollIntervalMs({ ...base, autoFollow: false }), 0);
  });

  it("an undetectable host polls only once the user confirmed this window", () => {
    assert.equal(pollIntervalMs({ ...base, host: "unknown" }), 0);
    assert.equal(pollIntervalMs({ ...base, host: "unknown", confirmedHere: false }), 0);
    assert.equal(pollIntervalMs({ ...base, host: "unknown", confirmedHere: true }), 1000);
  });

  it("cwdPollMs 0 disables polling", () => {
    assert.equal(pollIntervalMs({ ...base, cwdPollMs: 0 }), 0);
  });
});

describe("createHostState", () => {
  it("starts as no, notifies on each real change, and ignores a repeat", () => {
    let changes = 0;
    const host = createHostState(() => (changes += 1));
    assert.equal(host.get(), "no");
    host.set("no");
    assert.equal(changes, 0);
    host.set("yes");
    host.set("yes");
    assert.equal(host.get(), "yes");
    assert.equal(changes, 1);
    host.set("unknown");
    assert.equal(changes, 2);
  });
});
