import assert from "node:assert/strict";
import type { ProbeResult } from "../../../cwd";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import { FollowController } from "../../../follow/controller";
import type { Clock } from "../../../follow/controller";
import type { FolderLike, FolderPlan } from "../../../follow/planFolders";

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

function snap(cwd: string): SessionSnapshot {
  const pane: PaneInfo = { pane_id: "p1", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: true, cwd };
  return { focused_workspace_id: "w", focused_tab_id: "tab", focused_pane_id: "p1", panes: [pane], tabs: [], workspaces: [] };
}

interface Harness {
  controller: FollowController;
  clock: FakeClock;
  cwd: { value: string };
  plans: FolderPlan[];
  persisted: string[];
  order: string[];
  fetches: { count: number };
  folders: { value: FolderLike[]; multi: boolean };
  gate: { release: (() => void) | null; hold: boolean };
}

function harness(autoFollow = true): Harness {
  const clock = new FakeClock();
  const cwd = { value: "C:\\one" };
  const plans: FolderPlan[] = [];
  const persisted: string[] = [];
  const order: string[] = [];
  const fetches = { count: 0 };
  const folders = { value: [{ path: "C:\\anchor" }, { path: "C:\\start" }], multi: true };
  const gate: Harness["gate"] = { release: null, hold: false };
  const controller = new FollowController({
    platform: "win32",
    fetchSnapshot: async () => {
      fetches.count += 1;
      return snap(cwd.value);
    },
    applyPlan: async (plan) => {
      plans.push(plan);
      order.push("apply");
      if (plan.kind === "replace") {
        folders.value = folders.value.map((folder, index) => (index === plan.index ? { path: plan.add[0] ?? folder.path } : folder));
      }
      if (gate.hold) await new Promise<void>((resolve) => (gate.release = resolve));
      return true;
    },
    persistPendingTarget: async (target) => {
      order.push("persist");
      persisted.push(target);
    },
    switchFolder: async () => false,
    getFolders: () => folders.value,
    isMultiRoot: () => folders.multi,
    getAnchorPath: () => "C:\\anchor",
    autoFollow,
    debounceMs: 100,
    cwdSource: "auto",
    clock,
  });
  controller.setTrackedPath("C:\\start");
  return { controller, clock, cwd, plans, persisted, order, fetches, folders, gate };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("FollowController", () => {
  it("coalesces a burst of focus events into one apply after the debounce", async () => {
    const h = harness();
    h.controller.onFocusEvent();
    h.clock.advance(60);
    h.controller.onFocusEvent();
    h.clock.advance(60);
    assert.equal(h.fetches.count, 0);
    h.clock.advance(100);
    await h.controller.whenIdle();
    assert.equal(h.fetches.count, 1);
    assert.deepEqual(h.plans, [{ kind: "replace", index: 1, add: ["C:\\one"] }]);
    assert.equal(h.controller.getState().trackedPath, "C:\\one");
  });

  it("forwards isAdoptedAnchor to the planner so stale folders after a legacy anchor are reclaimed", async () => {
    const clock = new FakeClock();
    const plans: FolderPlan[] = [];
    const controller = new FollowController({
      platform: "win32",
      fetchSnapshot: async () => snap("C:\\one"),
      applyPlan: async (plan) => {
        plans.push(plan);
        return true;
      },
      persistPendingTarget: async () => undefined,
      switchFolder: async () => false,
      getFolders: () => [{ path: "C:\\legacy" }, { path: "C:\\stale" }, { path: "C:\\tracked" }],
      isMultiRoot: () => true,
      getAnchorPath: () => "C:\\legacy",
      isAdoptedAnchor: () => true,
      autoFollow: true,
      debounceMs: 100,
      cwdSource: "auto",
      clock,
    });
    controller.setTrackedPath("C:\\tracked");
    controller.onFocusEvent();
    clock.advance(100);
    await controller.whenIdle();
    assert.deepEqual(plans, [{ kind: "reclaim", index: 1, deleteCount: 2, add: ["C:\\one"] }]);
  });

  it("serializes: an event during an in-flight apply waits and uses the latest target", async () => {
    const h = harness();
    h.gate.hold = true;
    h.controller.onFocusEvent();
    h.clock.advance(100);
    await tick();
    assert.equal(h.plans.length, 1);

    h.cwd.value = "C:\\two";
    h.controller.onFocusEvent();
    h.clock.advance(100);
    await tick();
    assert.equal(h.plans.length, 1, "second apply must wait for the first");

    h.gate.hold = false;
    h.gate.release?.();
    await h.controller.whenIdle();
    assert.equal(h.plans.length, 2);
    assert.deepEqual(h.plans[1], { kind: "replace", index: 1, add: ["C:\\two"] });
  });

  it("drops stale intermediate targets: several events mid-apply cause one follow-up", async () => {
    const h = harness();
    h.gate.hold = true;
    h.controller.onFocusEvent();
    h.clock.advance(100);
    await tick();
    for (const next of ["C:\\a", "C:\\b", "C:\\c"]) {
      h.cwd.value = next;
      h.controller.onFocusEvent();
      h.clock.advance(100);
    }
    h.gate.hold = false;
    h.gate.release?.();
    await h.controller.whenIdle();
    assert.equal(h.plans.length, 2);
    assert.deepEqual(h.plans[1], { kind: "replace", index: 1, add: ["C:\\c"] });
  });

  it("ignores focus events while autoFollow is off", async () => {
    const h = harness(false);
    h.controller.onFocusEvent();
    assert.equal(h.clock.pending, 0);
    h.clock.advance(1000);
    await h.controller.whenIdle();
    assert.equal(h.fetches.count, 0);
  });

  it("turning autoFollow off cancels a pending debounce", async () => {
    const h = harness();
    h.controller.onFocusEvent();
    h.controller.setAutoFollow(false);
    h.clock.advance(1000);
    await h.controller.whenIdle();
    assert.equal(h.plans.length, 0);
  });

  it("followNow bypasses autoFollow and the debounce", async () => {
    const h = harness(false);
    await h.controller.followNow();
    assert.deepEqual(h.plans, [{ kind: "replace", index: 1, add: ["C:\\one"] }]);
  });

  it("persists the pending target before applying a convert plan", async () => {
    const h = harness();
    h.folders.value = [{ path: "C:\\anchor" }];
    h.folders.multi = false;
    h.controller.setTrackedPath(null);
    await h.controller.followNow();
    assert.deepEqual(h.persisted, ["C:\\one"]);
    assert.deepEqual(h.plans, [{ kind: "convert", start: 1, deleteCount: 0, add: ["C:\\one"] }]);
    assert.deepEqual(h.order, ["persist", "apply"]);
  });

  it("does not apply a convert plan when persisting fails", async () => {
    const h = harness();
    h.folders.value = [{ path: "C:\\anchor" }];
    h.folders.multi = false;
    const failing = new FollowController({
      platform: "win32",
      fetchSnapshot: async () => snap("C:\\one"),
      applyPlan: async (plan) => {
        h.plans.push(plan);
        return true;
      },
      persistPendingTarget: async () => {
        throw new Error("disk full");
      },
      switchFolder: async () => false,
      getFolders: () => h.folders.value,
      isMultiRoot: () => false,
      getAnchorPath: () => "C:\\anchor",
      autoFollow: true,
      debounceMs: 0,
      cwdSource: "auto",
    });
    await failing.followNow();
    assert.equal(h.plans.length, 0);
    assert.equal(failing.getState().lastError, "disk full");
  });

  it("does nothing further when the target is already open", async () => {
    const h = harness();
    h.cwd.value = "C:\\start";
    await h.controller.followNow();
    assert.equal(h.plans.length, 0);
  });

  it("clears the tracked slot after a remove plan", async () => {
    const h = harness();
    h.cwd.value = "C:\\anchor";
    await h.controller.followNow();
    assert.deepEqual(h.plans, [{ kind: "remove", index: 1 }]);
    assert.equal(h.controller.getState().trackedPath, null);
  });

  it("logs pane fields, target with source, plan, and mutation result for one cycle", async () => {
    const lines: string[] = [];
    const controller = new FollowController({
      platform: "win32",
      fetchSnapshot: async () => ({
        ...snap("C:\\spawn"),
        panes: [
          {
            pane_id: "p1",
            terminal_id: "t",
            workspace_id: "w",
            tab_id: "tab",
            focused: true,
            cwd: "C:\\spawn",
            foreground_cwd: "C:\\live",
            terminal_title: "bash",
          },
        ],
      }),
      applyPlan: async () => true,
      persistPendingTarget: async () => {},
      switchFolder: async () => false,
      getFolders: () => [{ path: "C:\\anchor" }, { path: "C:\\start" }],
      isMultiRoot: () => true,
      getAnchorPath: () => "C:\\anchor",
      autoFollow: true,
      debounceMs: 0,
      cwdSource: "auto",
      log: (level, msg) => lines.push(`[${level}] ${msg}`),
    });
    controller.setTrackedPath("C:\\start");
    await controller.followNow();
    const text = lines.join("\n");
    assert.match(text, /pane: id=p1 tab=tab workspace=w cwd=C:\\spawn foreground_cwd=C:\\live terminal_title=bash/);
    assert.match(text, /target: C:\\live via foreground_cwd/);
    assert.match(text, /plan: replace: index 1 -> C:\\live/);
    assert.match(text, /mutation: replace applied=true/);
  });

  describe("live cwd chain", () => {
    function liveController(
      live: { enabled: boolean; probe: (paneId: string) => Promise<ProbeResult> },
      lines: string[],
      fetchSnapshot: () => Promise<SessionSnapshot> = async () => snap("C:\\Users\\me\\"),
    ) {
      const clock = new FakeClock();
      const plans: FolderPlan[] = [];
      const controller = new FollowController({
        platform: "win32",
        fetchSnapshot,
        applyPlan: async (plan) => {
          plans.push(plan);
          return true;
        },
        persistPendingTarget: async () => {},
        switchFolder: async () => false,
        getFolders: () => [{ path: "C:\\anchor" }, { path: "C:\\start" }],
        isMultiRoot: () => true,
        getAnchorPath: () => "C:\\anchor",
        autoFollow: true,
        debounceMs: 100,
        cwdSource: "auto",
        clock,
        live: { ...live, platform: "win32" },
        log: (level, msg) => lines.push(`[${level}] ${msg}`),
      });
      controller.setTrackedPath("C:\\start");
      return { controller, clock, plans };
    }

    it("follows the probed directory and logs the probe as the source", async () => {
      const lines: string[] = [];
      const { controller, plans } = liveController({ enabled: true, probe: async () => ({ ok: true, path: "C:\\live" }) }, lines);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\live"] }]);
      assert.match(lines.join("\n"), /target: C:\\live via probe .* probe=\d+ms/);
    });

    it("logs a failed probe, still follows the spawn cwd, and emits the hint", async () => {
      const lines: string[] = [];
      const { controller, plans } = liveController({ enabled: true, probe: async () => ({ ok: false, reason: "Git Bash not found" }) }, lines);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\Users\\me"] }]);
      const text = lines.join("\n");
      assert.match(text, /via cwd .*failed=\[probe: Git Bash not found; foreground_cwd: absent\]/);
      assert.match(text, /hint: .*herdrNavigator\.liveCwdProbe.*docs\/shell-integration\.md/);
    });

    it("emits the hint without probing when the probe is disabled", async () => {
      const lines: string[] = [];
      let probes = 0;
      const { controller } = liveController({ enabled: false, probe: async () => (probes++, { ok: true, path: "C:\\live" }) }, lines);
      await controller.followNow();
      assert.equal(probes, 0);
      const text = lines.join("\n");
      assert.match(text, /via cwd .*failed=\[probe: disabled/);
      assert.match(text, /hint: /);
    });

    it("runs a single probe, for the final pane, when focus events arrive in a burst", async () => {
      const lines: string[] = [];
      const probed: string[] = [];
      let focused = 0;
      const { controller, clock } = liveController(
        { enabled: true, probe: async (paneId) => (probed.push(paneId), { ok: true, path: "C:\\live" }) },
        lines,
        async () => ({ ...snap("C:\\spawn"), focused_pane_id: `p${focused}`, panes: [{ ...snap("C:\\spawn").panes[0], pane_id: `p${focused}` }] }),
      );
      for (let i = 1; i <= 5; i++) {
        focused = i;
        controller.onFocusEvent();
        clock.advance(40);
      }
      clock.advance(100);
      await controller.whenIdle();
      assert.deepEqual(probed, ["p5"]);
    });

    it("skips applying a stale plan when focus changes during an in-flight probe", async () => {
      let focused = 1;
      const gate: { release?: () => void } = {};
      const probed: string[] = [];
      const { controller, clock, plans } = liveController(
        {
          enabled: true,
          probe: async (paneId) => {
            probed.push(paneId);
            if (paneId === "p1") await new Promise<void>((resolve) => (gate.release = resolve));
            return { ok: true, path: `C:\\live-${paneId}` };
          },
        },
        [],
        async () => ({ ...snap("C:\\spawn"), focused_pane_id: `p${focused}`, panes: [{ ...snap("C:\\spawn").panes[0], pane_id: `p${focused}` }] }),
      );
      controller.onFocusEvent();
      clock.advance(100);
      await tick();
      focused = 2;
      controller.onFocusEvent();
      clock.advance(100);
      gate.release?.();
      await controller.whenIdle();
      assert.deepEqual(probed, ["p1", "p2"]);
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\live-p2"] }]);
    });
  });

  it("only triggers on configured herdr event names", async () => {
    const h = harness();
    h.controller.onHerdrEvent("pane_updated");
    assert.equal(h.clock.pending, 0);
    h.controller.onHerdrEvent("tab_focused");
    assert.equal(h.clock.pending, 1);
  });

  describe("git root snapping", () => {
    function gitController(cwd: string, followGitRoot: boolean, lines: string[] = []) {
      const plans: FolderPlan[] = [];
      const controller = new FollowController({
        platform: "win32",
        fetchSnapshot: async () => snap(cwd),
        applyPlan: async (plan) => {
          plans.push(plan);
          return true;
        },
        persistPendingTarget: async () => {},
        switchFolder: async () => false,
        hasGitEntry: async (dir) => dir === "C:\\repo",
        followGitRoot,
        getFolders: () => [{ path: "C:\\anchor" }, { path: "C:\\repo" }],
        isMultiRoot: () => true,
        getAnchorPath: () => "C:\\anchor",
        autoFollow: true,
        debounceMs: 0,
        cwdSource: "auto",
        log: (level, msg) => lines.push(`[${level}] ${msg}`),
      });
      controller.setTrackedPath("C:\\repo");
      return { controller, plans, lines };
    }

    it("treats a subfolder of the tracked repository as a no-op", async () => {
      const { controller, plans, lines } = gitController("C:\\repo\\src\\game", true);
      await controller.followNow();
      assert.deepEqual(plans, []);
      assert.equal(controller.getState().lastTarget, "C:\\repo");
      assert.match(lines.join("\n"), /target: C:\\repo via .*\(git root of C:\\repo\\src\\game\)/);
    });

    it("follows the exact directory when the setting is off", async () => {
      const { controller, plans } = gitController("C:\\repo\\src\\game", false);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\repo\\src\\game"] }]);
    });

    it("follows the exact directory outside a repository", async () => {
      const { controller, plans } = gitController("C:\\other\\place", true);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\other\\place"] }]);
    });

    it("honors setFollowGitRoot at runtime", async () => {
      const { controller, plans } = gitController("C:\\repo\\src", true);
      controller.setFollowGitRoot(false);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\repo\\src"] }]);
    });
  });
});
