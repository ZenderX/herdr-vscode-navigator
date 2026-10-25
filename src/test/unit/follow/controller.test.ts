import assert from "node:assert/strict";
import type { ProbeResult } from "../../../cwd/types";
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
  currents: Array<() => boolean>;
}

function harness(autoFollow = true, onFetch?: () => void): Harness {
  const clock = new FakeClock();
  const cwd = { value: "C:\\one" };
  const plans: FolderPlan[] = [];
  const persisted: string[] = [];
  const order: string[] = [];
  const fetches = { count: 0 };
  const folders = { value: [{ path: "C:\\anchor" }, { path: "C:\\start" }], multi: true };
  const gate: Harness["gate"] = { release: null, hold: false };
  const currents: Harness["currents"] = [];
  const controller = new FollowController({
    platform: "win32",
    fetchSnapshot: async () => {
      fetches.count += 1;
      onFetch?.();
      return snap(cwd.value);
    },
    applyPlan: async (plan, isCurrent) => {
      currents.push(isCurrent);
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
  return { controller, clock, cwd, plans, persisted, order, fetches, folders, gate, currents };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("FollowController", () => {
  it("coalesces a burst of focus events into one apply after the debounce, and ignores them while auto-follow is off", async () => {
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

    const off = harness(false);
    off.controller.onFocusEvent();
    off.clock.advance(1000);
    await off.controller.whenIdle();
    assert.equal(off.fetches.count, 0);
  });

  it("serializes applies: several events during an in-flight apply cause one follow-up to the latest target", async () => {
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

    it("follows the probed directory, and the spawn cwd with a hint when the probe fails", async () => {
      const { controller, plans } = liveController({ enabled: true, probe: async () => ({ ok: true, path: "C:\\live" }) }, []);
      await controller.followNow();
      assert.deepEqual(plans, [{ kind: "replace", index: 1, add: ["C:\\live"] }]);

      const lines: string[] = [];
      const failed = liveController({ enabled: true, probe: async () => ({ ok: false, reason: "Git Bash not found" }) }, lines);
      await failed.controller.followNow();
      assert.deepEqual(failed.plans, [{ kind: "replace", index: 1, add: ["C:\\Users\\me"] }]);
      const hint = lines.find((line) => line.includes("hint:")) ?? "";
      // The hint points at the two settings that fix the probe; no doc it names may go missing.
      assert.match(hint, /herdrNavigator\.liveCwdProbe and herdrNavigator\.gitBashPath settings$/);
      assert.doesNotMatch(hint, /\.md\b/);
    });
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

    it("treats a subfolder of the tracked repository as a no-op, and follows the exact directory when the setting is off", async () => {
      const snapped = gitController("C:\\repo\\src\\game", true);
      await snapped.controller.followNow();
      assert.deepEqual(snapped.plans, []);
      assert.equal(snapped.controller.getState().lastTarget, "C:\\repo");

      const exact = gitController("C:\\repo\\src\\game", true);
      exact.controller.setFollowGitRoot(false);
      await exact.controller.followNow();
      assert.deepEqual(exact.plans, [{ kind: "replace", index: 1, add: ["C:\\repo\\src\\game"] }]);
    });
  });
});
