import assert from "node:assert/strict";
import type { SessionSnapshot } from "../../../herdr";
import { createWindowTitleSync, focusedLabel } from "../../../vscode/windowTitle";
import type { TitleInspection } from "../../../vscode/windowTitle";

const WIN_DEFAULT = "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";
const winTitle = (slot: string): string => `\${dirty}\${activeEditorShort}\${separator}${slot}\${separator}\${profileName}\${separator}\${appName}`;
const macTitle = (slot: string): string => `\${activeEditorShort}\${separator}${slot}\${separator}\${profileName}`;
const LEGACY_WIN = winTitle("herdr-navigation (Workspace)");

function setup(inspection: TitleInspection | undefined, { platform = "win32", recorded }: { platform?: NodeJS.Platform; recorded?: string } = {}) {
  const writes: Array<string | undefined> = [];
  let remembered = recorded;
  const sync = createWindowTitleSync({
    platform,
    config: () => ({
      inspect: () => inspection,
      update: async (value) => {
        writes.push(value);
        if (inspection !== undefined) inspection.workspaceValue = value;
      },
    }),
    recorded: {
      get: () => remembered,
      set: async (value) => {
        remembered = value;
      },
    },
    initialLabel: () => undefined,
    log: () => undefined,
  });
  return { sync, writes, remembered: () => remembered };
}

const snap = (focused: string | null, workspaces: Array<Record<string, unknown>>): SessionSnapshot => ({
  focused_workspace_id: focused,
  focused_tab_id: null,
  focused_pane_id: null,
  panes: [],
  tabs: [],
  workspaces,
});

describe("window title sync", () => {
  it("puts the focused space's sanitized label in the root slot of the platform default, once per new label", async () => {
    const spaces = [{ workspace_id: "w1", label: "alpha" }, { workspace_id: "w2", label: "a$b\nc" }, { workspace_id: "w3" }];
    const { sync, writes, remembered } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, focusedLabel(snap("w1", spaces)));
    await sync(true, focusedLabel(snap("w2", spaces)));
    await sync(true, focusedLabel(snap("w2", spaces)));
    await sync(true, focusedLabel(snap(null, spaces)));
    await sync(true, focusedLabel(snap("w3", spaces)));
    assert.deepEqual(writes, [winTitle("alpha"), winTitle("a＄b c")]);
    assert.equal(remembered(), winTitle("a＄b c"));

    const mac = setup({}, { platform: "darwin" });
    await mac.sync(true, "api");
    assert.deepEqual(mac.writes, [macTitle("api")]);
  });

  it("replaces values it wrote before but leaves a user-set title alone", async () => {
    for (const workspaceValue of [LEGACY_WIN, winTitle("old space"), winTitle("herdr - old")]) {
      const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue });
      await sync(true, "api");
      assert.deepEqual(writes, [winTitle("api")], workspaceValue);
    }
    for (const workspaceValue of ["my title", winTitle("${folderName}")]) {
      const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue });
      await sync(true, "api");
      assert.deepEqual(writes, [], workspaceValue);
    }
  });

  it("clears its own value and record outside a navigator window, but never a user's", async () => {
    const own = setup({ defaultValue: WIN_DEFAULT, workspaceValue: LEGACY_WIN }, { recorded: LEGACY_WIN });
    await own.sync(false);
    assert.deepEqual(own.writes, [undefined]);
    assert.equal(own.remembered(), undefined);
    const user = setup({ defaultValue: WIN_DEFAULT, workspaceValue: winTitle("My Project") });
    await user.sync(false, "api");
    assert.deepEqual(user.writes, []);
  });
});
