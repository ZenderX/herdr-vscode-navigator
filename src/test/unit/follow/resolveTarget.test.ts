import assert from "node:assert/strict";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import { resolveCwd } from "../../../cwd/liveCwd";
import type { CwdSource } from "../../../follow/resolveTarget";
import { resolveTarget as resolveTargetOn } from "../../../follow/resolveTarget";

// Fixtures use Windows paths, so the platform is pinned rather than read from the host.
const resolveTarget = (snap: SessionSnapshot, source: CwdSource, live?: ReturnType<typeof resolveCwd>) =>
  resolveTargetOn(snap, source, live, "win32");

function pane(overrides: Partial<PaneInfo>): PaneInfo {
  return { pane_id: "p1", terminal_id: "t1", workspace_id: "w1", tab_id: "tab1", focused: false, ...overrides };
}

function snapshot(panes: PaneInfo[], focusedPaneId: string | null = "p1"): SessionSnapshot {
  return {
    focused_workspace_id: "w1",
    focused_tab_id: "tab1",
    focused_pane_id: focusedPaneId,
    panes,
    tabs: [],
    workspaces: [],
  };
}

describe("resolveTarget", () => {
  it("auto prefers foreground_cwd over cwd", () => {
    const snap = snapshot([pane({ cwd: "C:\\a", foreground_cwd: "C:\\b" })]);
    assert.equal(resolveTarget(snap, "auto").target, "C:\\b");
  });

  it("auto falls back to cwd when foreground_cwd is null or absent", () => {
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\Users\\me\\", foreground_cwd: null })]), "auto").target, "C:\\Users\\me");
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\a" })]), "auto").target, "C:\\a");
  });

  it("pane source ignores foreground_cwd", () => {
    const snap = snapshot([pane({ cwd: "C:\\a", foreground_cwd: "C:\\b" })]);
    assert.equal(resolveTarget(snap, "pane").target, "C:\\a");
  });

  it("foreground source ignores cwd and yields null when foreground_cwd is missing", () => {
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\a", foreground_cwd: "C:\\b" })]), "foreground").target, "C:\\b");
    const missing = resolveTarget(snapshot([pane({ cwd: "C:\\a" })]), "foreground");
    assert.equal(missing.target, null);
    assert.match(missing.reason, /no usable cwd/);
  });

  it("normalizes MSYS cwd", () => {
    assert.equal(resolveTarget(snapshot([pane({ cwd: "/c/Users/me/proj" })]), "auto").target, "C:\\Users\\me\\proj");
  });

  it("picks the pane matching focused_pane_id, not the first one", () => {
    const snap = snapshot([pane({ pane_id: "p1", cwd: "C:\\one" }), pane({ pane_id: "p2", cwd: "C:\\two" })], "p2");
    assert.equal(resolveTarget(snap, "auto").target, "C:\\two");
  });

  it("falls back to the focused pane in the focused tab, then any focused pane", () => {
    const inTab = snapshot(
      [pane({ pane_id: "p1", tab_id: "other", focused: true, cwd: "C:\\other" }), pane({ pane_id: "p2", focused: true, cwd: "C:\\tab" })],
      null,
    );
    assert.equal(resolveTarget(inTab, "auto").target, "C:\\tab");
    const anyFocused = snapshot([pane({ pane_id: "p1", tab_id: "other", focused: true, cwd: "C:\\other" })], null);
    assert.equal(resolveTarget(anyFocused, "auto").target, "C:\\other");
  });

  it("reports the source of the chosen field", () => {
    const both = snapshot([pane({ cwd: "C:\\a", foreground_cwd: "C:\\b" })]);
    assert.equal(resolveTarget(both, "auto").source, "foreground_cwd");
    assert.equal(resolveTarget(both, "pane").source, "cwd");
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\a" })]), "auto").source, "cwd");
  });

  describe("live chain (auto mode)", () => {
    const fields = { cwd: "C:\\Users\\me\\", foreground_cwd: "C:\\fg" };
    const snap = snapshot([pane(fields)]);

    it("probe wins over foreground_cwd and cwd", () => {
      const live = resolveCwd(fields, { ok: true, path: "C:\\live" }, { enabled: true }, "win32");
      const resolved = resolveTarget(snap, "auto", live);
      assert.equal(resolved.target, "C:\\live");
      assert.equal(resolved.source, "probe");
    });

    it("a failed probe is recorded and does not block following: foreground_cwd, then cwd", () => {
      const failed = resolveCwd(fields, { ok: false, reason: "Git Bash not found" }, { enabled: true }, "win32");
      const viaForeground = resolveTarget(snap, "auto", failed);
      assert.equal(viaForeground.source, "foreground_cwd");
      assert.deepEqual(viaForeground.attempts, [{ source: "probe", reason: "Git Bash not found" }]);

      const cwdOnly = pane({ cwd: "C:\\Users\\me\\" });
      const viaCwd = resolveTarget(snapshot([cwdOnly]), "auto", resolveCwd(cwdOnly, { ok: false, reason: "x" }, { enabled: true }, "win32"));
      assert.equal(viaCwd.source, "cwd");
      assert.equal(viaCwd.target, "C:\\Users\\me");
      assert.deepEqual(
        viaCwd.attempts.map(({ source }) => source),
        ["probe", "foreground_cwd"],
      );
    });

    it("pane and foreground modes ignore the live chain", () => {
      const live = resolveCwd(fields, { ok: true, path: "C:\\live" }, { enabled: true }, "win32");
      assert.equal(resolveTarget(snap, "pane", live).target, "C:\\Users\\me");
    });
  });

  it("returns null with a reason when there is no focused pane or no cwd", () => {
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\a" })], "nope"), "auto").target, null);
    const noCwd = resolveTarget(snapshot([pane({ cwd: null })]), "auto");
    assert.equal(noCwd.target, null);
    assert.match(noCwd.reason, /no usable cwd/);
  });
});
