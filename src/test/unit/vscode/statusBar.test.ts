import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { INSTALL_COMMAND, LAUNCH_COMMAND, StatusBar, TOGGLE_COMMAND } from "../../../vscode/statusBar";
import type { StatusBarItemLike } from "../../../vscode/statusBar";
import type { ThemeColor } from "vscode";

interface FakeItem extends StatusBarItemLike {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  color: string | ThemeColor | undefined;
  shown: number;
}

function fakeItem(): FakeItem {
  return { text: "", tooltip: undefined, command: undefined, color: undefined, shown: 0, show() { this.shown++; }, dispose() {} };
}

const themeColor = (id: string): ThemeColor => ({ id }) as ThemeColor;

describe("StatusBar auto-follow look", () => {
  it("shows an open eye with the default colour when auto-follow is on", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, true, "C:\\proj\\app", true);
    assert.match(item.text, /^\$\(eye\) herdr: app/);
    assert.equal(item.color, undefined);
    assert.equal("backgroundColor" in item, false);
  });

  it("shows a closed eye in the muted colour when auto-follow is off", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, false, "C:\\proj\\app", true);
    assert.match(item.text, /^\$\(eye-closed\) herdr: app/);
    assert.deepEqual(item.color, { id: "disabledForeground" });
    assert.equal("backgroundColor" in item, false);
  });

  it("clears the muted colour when auto-follow comes back on", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, false, null, true);
    bar.update(true, true, null, true);
    assert.equal(item.color, undefined);
  });

  it("still reflects the auto-follow setting while offering launch", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(false, false, null, false);
    assert.match(item.text, /^\$\(eye-closed\)/);
    assert.equal(item.command, LAUNCH_COMMAND);
  });
});

describe("StatusBar when herdr is not installed", () => {
  it("says so, keeps the eye icon, and clicks through to the install page command", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(false, true, null, false, undefined, false);
    assert.equal(item.text, "$(eye) herdr: not installed");
    assert.equal(item.command, INSTALL_COMMAND);
    assert.match(item.tooltip ?? "", /install page/);
  });

  it("shows no not-installed text by default (before the first resolution completes)", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(false, true, null, false);
    assert.doesNotMatch(item.text, /not installed/);
    assert.doesNotMatch(item.tooltip ?? "", /not installed/);
    assert.equal(item.command, LAUNCH_COMMAND);
  });

  it("restores the launch click once herdr is found again", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(false, false, null, false, undefined, false);
    assert.match(item.text, /^\$\(eye-closed\) herdr: not installed/);
    bar.update(false, false, null, false, undefined, true);
    assert.equal(item.command, LAUNCH_COMMAND);
    assert.match(item.text, /herdr: disconnected/);
  });
});

describe("StatusBar click action", () => {
  it("offers launch while herdr is not running in this window", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(false, true, null, false);
    assert.equal(item.command, LAUNCH_COMMAND);
    assert.match(item.tooltip ?? "", /click to launch herdr/);
    assert.equal(item.shown, 1);
  });

  it("offers the auto-follow toggle while herdr runs in this window", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, true, "C:\\proj\\app", true);
    assert.equal(item.command, TOGGLE_COMMAND);
    assert.match(item.tooltip ?? "", /click to toggle auto-follow/);
  });

  it("switches back to launch when herdr stops running", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, true, null, true);
    bar.update(false, true, null, false);
    assert.equal(item.command, LAUNCH_COMMAND);
  });
});
