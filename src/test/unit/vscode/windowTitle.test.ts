import assert from "node:assert/strict";
import { buildWindowTitle, createWindowTitleSync } from "../../../vscode/windowTitle";
import type { TitleInspection } from "../../../vscode/windowTitle";

const WIN_DEFAULT = "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";
const MAC_DEFAULT = "${activeEditorShort}${separator}${rootName}${separator}${profileName}";
const WIN_TITLE =
  "${dirty}${activeEditorShort}${separator}herdr-navigation (Workspace)${separator}${profileName}${separator}${appName}";
const MAC_TITLE = "${activeEditorShort}${separator}herdr-navigation (Workspace)${separator}${profileName}";

function setup(inspection: TitleInspection | undefined, platform: NodeJS.Platform = "win32") {
  const writes: Array<string | undefined> = [];
  const logs: string[] = [];
  const sync = createWindowTitleSync({
    platform,
    config: () => ({
      inspect: () => inspection,
      update: async (value) => {
        writes.push(value);
      },
    }),
    log: (_level, msg) => logs.push(msg),
  });
  return { sync, writes, logs };
}

describe("buildWindowTitle", () => {
  it("replaces rootName with the long name in the Windows/Linux default", () => {
    assert.equal(buildWindowTitle(WIN_DEFAULT), WIN_TITLE);
  });

  it("replaces rootName in the macOS default", () => {
    assert.equal(buildWindowTitle(MAC_DEFAULT), MAC_TITLE);
  });

  it("replaces rootNameShort with the bare name", () => {
    assert.equal(buildWindowTitle("${rootNameShort} - ${appName}"), "herdr-navigation - ${appName}");
  });

  it("replaces every rootName token", () => {
    assert.equal(buildWindowTitle("${rootName}|${rootName}"), "herdr-navigation (Workspace)|herdr-navigation (Workspace)");
  });

  it("returns undefined when the template has neither token", () => {
    assert.equal(buildWindowTitle("${activeEditorShort} - ${appName}"), undefined);
  });
});

describe("window title sync", () => {
  it("writes the Windows/Linux default layout when defaultValue is reported", async () => {
    const { sync, writes, logs } = setup({ defaultValue: WIN_DEFAULT });
    await sync(true);
    assert.deepEqual(writes, [WIN_TITLE]);
    assert.match(logs.join("\n"), /window title: wrote /);
  });

  it("writes the macOS default layout", async () => {
    const { sync, writes } = setup({ defaultValue: MAC_DEFAULT }, "darwin");
    await sync(true);
    assert.deepEqual(writes, [MAC_TITLE]);
  });

  it("prefers the user's global template over the default", async () => {
    const { sync, writes } = setup({ globalValue: "${rootNameShort} !", defaultValue: WIN_DEFAULT });
    await sync(true);
    assert.deepEqual(writes, ["herdr-navigation !"]);
  });

  it("writes nothing and logs once when the template has no root token", async () => {
    const { sync, writes, logs } = setup({ globalValue: "${appName}", defaultValue: WIN_DEFAULT });
    await sync(true);
    await sync(true);
    assert.deepEqual(writes, []);
    assert.equal(logs.length, 1);
  });

  it("clears its own stale value when the template no longer has a root token", async () => {
    const { sync, writes, logs } = setup({ globalValue: "${appName}", workspaceValue: WIN_TITLE });
    await sync(true);
    assert.deepEqual(writes, [undefined]);
    assert.match(logs.join("\n"), /cleared the workspace value/);
  });

  it("leaves a user-owned value alone when the template has no root token", async () => {
    const { sync, writes } = setup({ globalValue: "${appName}", workspaceValue: "my title" });
    await sync(true);
    assert.deepEqual(writes, []);
  });

  for (const [platform, expected] of [
    ["win32", WIN_TITLE],
    ["linux", WIN_TITLE],
    ["darwin", MAC_TITLE],
  ] as const) {
    it(`falls back to the ${platform} default when defaultValue is undefined`, async () => {
      const { sync, writes } = setup({}, platform);
      await sync(true);
      assert.deepEqual(writes, [expected]);
    });
  }

  it("falls back when inspect returns undefined", async () => {
    const { sync, writes } = setup(undefined);
    await sync(true);
    assert.deepEqual(writes, [WIN_TITLE]);
  });

  it("does nothing when the workspace value already matches", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: WIN_TITLE });
    await sync(true);
    assert.deepEqual(writes, []);
  });

  it("overwrites a stale value it wrote earlier", async () => {
    const { sync, writes } = setup({ defaultValue: MAC_DEFAULT, workspaceValue: "old herdr-navigation" }, "darwin");
    await sync(true);
    assert.deepEqual(writes, [MAC_TITLE]);
  });

  it("leaves a user-owned workspace value alone and logs once", async () => {
    const { sync, writes, logs } = setup({ defaultValue: WIN_DEFAULT, workspaceValue: "my title" });
    await sync(true);
    await sync(true);
    assert.deepEqual(writes, []);
    assert.equal(logs.length, 1);
  });

  it("never writes in a non-navigator window", async () => {
    const { sync, writes } = setup({ defaultValue: WIN_DEFAULT });
    await sync(false);
    assert.deepEqual(writes, []);
  });

  it("leaves a user-owned value in a non-navigator window", async () => {
    const { sync, writes } = setup({ workspaceValue: "my title" });
    await sync(false);
    assert.deepEqual(writes, []);
  });

  it("clears an extension-written value once the anchor is gone", async () => {
    const { sync, writes } = setup({ workspaceValue: WIN_TITLE });
    await sync(false);
    assert.deepEqual(writes, [undefined]);
  });
});
