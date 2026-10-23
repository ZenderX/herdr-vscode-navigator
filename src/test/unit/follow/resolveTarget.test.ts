import assert from "node:assert/strict";
import type { PaneInfo, SessionSnapshot } from "../../../herdr";
import type { CwdSource } from "../../../follow/resolveTarget";
import { resolveTarget as resolveTargetOn } from "../../../follow/resolveTarget";

// Fixtures use Windows paths, so the platform is pinned rather than read from the host.
const resolveTarget = (snap: SessionSnapshot, source: CwdSource) => resolveTargetOn(snap, source, undefined, "win32");

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
  it("follows foreground_cwd before cwd in auto mode, honours the pane and foreground sources, and normalizes MSYS paths", () => {
    const both = snapshot([pane({ cwd: "C:\\a", foreground_cwd: "C:\\b" })]);
    assert.deepEqual([resolveTarget(both, "auto").target, resolveTarget(both, "auto").source], ["C:\\b", "foreground_cwd"]);
    assert.equal(resolveTarget(both, "pane").target, "C:\\a");
    assert.equal(resolveTarget(both, "foreground").target, "C:\\b");
    assert.equal(resolveTarget(snapshot([pane({ cwd: "/c/Users/me/proj", foreground_cwd: null })]), "auto").target, "C:\\Users\\me\\proj");
    const missing = resolveTarget(snapshot([pane({ cwd: "C:\\a" })]), "foreground");
    assert.equal(missing.target, null);
    assert.match(missing.reason, /no usable cwd/);
  });

  it("picks the pane matching focused_pane_id, then the focused pane in the focused tab, then any focused pane", () => {
    const byId = snapshot([pane({ pane_id: "p1", cwd: "C:\\one" }), pane({ pane_id: "p2", cwd: "C:\\two" })], "p2");
    assert.equal(resolveTarget(byId, "auto").target, "C:\\two");
    const inTab = snapshot(
      [pane({ pane_id: "p1", tab_id: "other", focused: true, cwd: "C:\\other" }), pane({ pane_id: "p2", focused: true, cwd: "C:\\tab" })],
      null,
    );
    assert.equal(resolveTarget(inTab, "auto").target, "C:\\tab");
    const anyFocused = snapshot([pane({ pane_id: "p1", tab_id: "other", focused: true, cwd: "C:\\other" })], null);
    assert.equal(resolveTarget(anyFocused, "auto").target, "C:\\other");
    assert.equal(resolveTarget(snapshot([pane({ cwd: "C:\\a" })], "nope"), "auto").target, null);
  });
});
