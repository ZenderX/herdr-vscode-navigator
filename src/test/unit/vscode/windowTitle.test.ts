import assert from "node:assert/strict";
import type { SessionSnapshot } from "../../../herdr";
import { buildWindowTitle, createWindowTitleSync, focusedLabel, sanitizeLabel } from "../../../vscode/windowTitle";
import type { TitleInspection } from "../../../vscode/windowTitle";

const WIN_DEFAULT = "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";
const MAC_DEFAULT = "${activeEditorShort}${separator}${rootName}${separator}${profileName}";
const winTitle = (slot: string): string => `\${dirty}\${activeEditorShort}\${separator}${slot}\${separator}\${profileName}\${separator}\${appName}`;
const macTitle = (slot: string): string => `\${activeEditorShort}\${separator}${slot}\${separator}\${profileName}`;
const LEGACY_WIN = winTitle("herdr-navigation (Workspace)");

interface SetupOptions {
  platform?: NodeJS.Platform;
  recorded?: string;
  initialLabel?: string;
}

function setup(inspection: TitleInspection | undefined, { platform = "win32", recorded, initialLabel }: SetupOptions = {}) {
  const writes: Array<string | undefined> = [];
  const logs: string[] = [];
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
    initialLabel: () => initialLabel,
    log: (_level, msg) => logs.push(msg),
  });
  return { sync, writes, logs, remembered: () => remembered };
}

describe("sanitizeLabel", () => {
  it("replaces every dollar so no variable can open, and flattens line breaks", () => {
    assert.equal(sanitizeLabel("a$b${x}\r\nc"), "a＄b＄{x} c");
  });

  it("leaves braces, quotes and Unicode alone", () => {
    assert.equal(sanitizeLabel('}{"é 日本'), '}{"é 日本');
  });
});

describe("buildWindowTitle", () => {
  it("puts exactly the label in the root slot of the Windows/Linux default", () => {
    assert.equal(buildWindowTitle(WIN_DEFAULT, "api"), winTitle("api"));
  });

  it("puts exactly the label in the root slot of the macOS default", () => {
    assert.equal(buildWindowTitle(MAC_DEFAULT, "api"), macTitle("api"));
  });

  it("adds no herdr prefix: the herdr terminal tab already supplies it via activeEditorShort", () => {
    assert.equal(buildWindowTitle("${activeEditorShort}${separator}${rootName}", "L"), "${activeEditorShort}${separator}L");
  });

  it("replaces rootNameShort and every token", () => {
    assert.equal(buildWindowTitle("${rootNameShort}|${rootName}", "x"), "x|x");
  });

  it("never writes the (Workspace) suffix", () => {
    assert.ok(!buildWindowTitle(WIN_DEFAULT, "api")?.includes("(Workspace)"));
  });

  it("sanitizes a hostile label", () => {
    assert.equal(buildWindowTitle("${rootName}", "a$b\nc"), "a＄b c");
  });

  it("returns undefined when the template has neither token", () => {
    assert.equal(buildWindowTitle("${activeEditorShort} - ${appName}", "x"), undefined);
  });
});

describe("focusedLabel", () => {
  const snapshot = (workspaces: Array<Record<string, unknown>>, focused: string | null): SessionSnapshot => ({
    focused_workspace_id: focused,
    focused_tab_id: null,
    focused_pane_id: null,
    panes: [],
    tabs: [],
    workspaces,
  });

  it("returns the focused workspace's label", () => {
    assert.equal(focusedLabel(snapshot([{ workspace_id: "w1", label: "a" }, { workspace_id: "w2", label: "b" }], "w2")), "b");
  });

  it("returns undefined with no focused space or no label", () => {
    assert.equal(focusedLabel(snapshot([{ workspace_id: "w1", label: "a" }], null)), undefined);
    assert.equal(focusedLabel(snapshot([{ workspace_id: "w1" }], "w1")), undefined);
  });
});

describe("window title sync", () => {
  it("writes the label into the default layout and records it", async () => {
    const { sync, writes, logs, remembered } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, "api");
    assert.deepEqual(writes, [winTitle("api")]);
    assert.equal(remembered(), winTitle("api"));
    assert.match(logs.join("\n"), /window title: wrote /);
  });

  it("writes the macOS layout", async () => {
    const { sync, writes } = setup({ defaultValue: MAC_DEFAULT }, { platform: "darwin" });
    await sync(true, "api");
    assert.deepEqual(writes, [macTitle("api")]);
  });

  it("prefers the user's global template over the default", async () => {
    const { sync, writes } = setup({ globalValue: "${rootNameShort} !", defaultValue: WIN_DEFAULT });
    await sync(true, "api");
    assert.deepEqual(writes, ["api !"]);
  });

  for (const [platform, expected] of [
    ["win32", winTitle("api")],
    ["linux", winTitle("api")],
    ["darwin", macTitle("api")],
  ] as const) {
    it(`falls back to the ${platform} default when defaultValue is undefined`, async () => {
      const { sync, writes } = setup({}, { platform });
      await sync(true, "api");
      assert.deepEqual(writes, [expected]);
    });
  }

  it("falls back when inspect returns undefined", async () => {
    const { sync, writes } = setup(undefined);
    await sync(true, "api");
    assert.deepEqual(writes, [winTitle("api")]);
  });

  it("writes a sanitized label with a dollar and a newline", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, "a$b\nc");
    assert.deepEqual(writes, [winTitle("a＄b c")]);
  });

  it("replaces a 0.1.x long-name value", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: LEGACY_WIN });
    await sync(true, "api");
    assert.deepEqual(writes, [winTitle("api")]);
  });

  it("replaces a 0.1.x short-name value", async () => {
    const { sync, writes } = setup({ globalValue: "${rootNameShort} !", workspaceValue: "herdr-navigation !" });
    await sync(true, "api");
    assert.deepEqual(writes, ["api !"]);
  });

  it("replaces the value it recorded earlier even when it carries no marker", async () => {
    const earlier = "my-recorded-slot";
    const { sync, writes } = setup({ globalValue: "${rootName}", workspaceValue: earlier }, { recorded: earlier });
    await sync(true, "api");
    assert.deepEqual(writes, ["api"]);
  });

  it("replaces a shape-matched value with an arbitrary literal in the root slot", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: winTitle("old space") });
    await sync(true, "api");
    assert.deepEqual(writes, [winTitle("api")]);
  });

  it("replaces a value written by the earlier herdr-prefixed form", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: winTitle("herdr - old") });
    await sync(true, "api");
    assert.deepEqual(writes, [winTitle("api")]);
  });

  it("leaves a user-set value alone and logs once", async () => {
    const { sync, writes, logs } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: "my title" });
    await sync(true, "api");
    await sync(true, "api");
    assert.deepEqual(writes, []);
    assert.equal(logs.length, 1);
  });

  it("does not treat any value as shaped when the template is only the root token", async () => {
    const { sync, writes } = setup({ globalValue: "${rootName}", workspaceValue: "my title" });
    await sync(true, "api");
    assert.deepEqual(writes, []);
  });

  it("makes no update call when the value is already current", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: winTitle("api") });
    await sync(true, "api");
    assert.deepEqual(writes, []);
  });

  it("writes nothing and logs once when the template has no root token", async () => {
    const { sync, writes, logs } = setup({ globalValue: "${appName}", defaultValue: WIN_DEFAULT });
    await sync(true, "api");
    await sync(true, "api");
    assert.deepEqual(writes, []);
    assert.equal(logs.length, 1);
  });

  it("clears its own stale value when the template no longer has a root token", async () => {
    const { sync, writes, logs } = setup({ globalValue: "${appName}", workspaceValue: LEGACY_WIN });
    await sync(true, "api");
    assert.deepEqual(writes, [undefined]);
    assert.match(logs.join("\n"), /cleared the workspace value/);
  });

  it("leaves a user-set value alone when the template has no root token", async () => {
    const { sync, writes } = setup({ globalValue: "${appName}", workspaceValue: "my title" });
    await sync(true, "api");
    assert.deepEqual(writes, []);
  });

  it("never writes in a non-navigator window", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(false, "api");
    assert.deepEqual(writes, []);
  });

  it("leaves a user-set value in a non-navigator window", async () => {
    const { sync, writes } = setup({ workspaceValue: "my title" });
    await sync(false);
    assert.deepEqual(writes, []);
  });

  it("leaves a shape-matched user value alone in a non-navigator window", async () => {
    for (const workspaceValue of [winTitle("My Project"), winTitle("${folderName}")]) {
      const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue });
      await sync(false, "api");
      assert.deepEqual(writes, []);
    }
  });

  it("clears a recorded value and a legacy-marker value in a non-navigator window", async () => {
    const recordedValue = winTitle("api");
    const a = setup({ defaultValue: WIN_DEFAULT, workspaceValue: recordedValue }, { recorded: recordedValue });
    await a.sync(false);
    assert.deepEqual(a.writes, [undefined]);
    const b = setup({ defaultValue: WIN_DEFAULT, workspaceValue: LEGACY_WIN });
    await b.sync(false);
    assert.deepEqual(b.writes, [undefined]);
  });

  it("does not claim a navigator-window value with a variable in the root slot", async () => {
    for (const slot of ["${activeFolderShort}", "${folderName}"]) {
      const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: winTitle(slot) });
      await sync(true, "api");
      assert.deepEqual(writes, []);
    }
  });

  it("clears an extension-written value and its record once the anchor is gone", async () => {
    const { sync, writes, remembered } = setup({ workspaceValue: LEGACY_WIN }, { recorded: LEGACY_WIN });
    await sync(false);
    assert.deepEqual(writes, [undefined]);
    assert.equal(remembered(), undefined);
  });
});

describe("window title wiring", () => {
  it("follows the focused space: one write per new label, none for a repeat or a missing label", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, "alpha");
    await sync(true, "beta");
    await sync(true, "beta");
    await sync(true, undefined);
    assert.deepEqual(writes, [winTitle("alpha"), winTitle("beta")]);
  });

  it("drives snapshots through focusedLabel into the title", async () => {
    const snap = (focused: string | null, workspaces: Array<Record<string, unknown>>): SessionSnapshot => ({
      focused_workspace_id: focused,
      focused_tab_id: null,
      focused_pane_id: null,
      panes: [],
      tabs: [],
      workspaces,
    });
    const spaces = [
      { workspace_id: "w1", label: "alpha" },
      { workspace_id: "w2", label: "beta" },
      { workspace_id: "w3" },
    ];
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, focusedLabel(snap("w1", spaces)));
    assert.deepEqual(writes, [winTitle("alpha")]);
    await sync(true, focusedLabel(snap("w2", spaces)));
    assert.deepEqual(writes, [winTitle("alpha"), winTitle("beta")]);
    await sync(true, focusedLabel(snap("w2", spaces)));
    await sync(true, focusedLabel(snap(null, spaces)));
    await sync(true, focusedLabel(snap("w3", spaces)));
    assert.equal(writes.length, 2);
  });

  it("keeps the last label when no space is focused", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true, "alpha");
    await sync(true, undefined);
    assert.equal(writes.length, 1);
  });

  it("starts from the persisted last-focused label", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT }, { initialLabel: "saved" });
    await sync(true);
    assert.deepEqual(writes, [winTitle("saved")]);
  });

  it("uses herdr-navigation when no label is known yet", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true);
    assert.deepEqual(writes, [winTitle("herdr-navigation")]);
  });
});
