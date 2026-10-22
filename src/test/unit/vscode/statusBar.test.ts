import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { LAUNCH_COMMAND, StatusBar, TOGGLE_COMMAND } from "../../../vscode/statusBar";
import type { StatusBarItemLike } from "../../../vscode/statusBar";

interface FakeItem extends StatusBarItemLike {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  shown: number;
}

function fakeItem(): FakeItem {
  return { text: "", tooltip: undefined, command: undefined, shown: 0, show() { this.shown++; }, dispose() {} };
}

describe("StatusBar click action", () => {
  it("offers launch while herdr is not running in this window", () => {
    const item = fakeItem();
    const bar = new StatusBar(item);
    bar.update(false, true, null, false);
    assert.equal(item.command, LAUNCH_COMMAND);
    assert.match(item.tooltip ?? "", /click to launch herdr/);
    assert.equal(item.shown, 1);
  });

  it("offers the auto-follow toggle while herdr runs in this window", () => {
    const item = fakeItem();
    const bar = new StatusBar(item);
    bar.update(true, true, "C:\\proj\\app", true);
    assert.equal(item.command, TOGGLE_COMMAND);
    assert.match(item.tooltip ?? "", /click to toggle auto-follow/);
  });

  it("switches back to launch when herdr stops running", () => {
    const item = fakeItem();
    const bar = new StatusBar(item);
    bar.update(true, true, null, true);
    bar.update(false, true, null, false);
    assert.equal(item.command, LAUNCH_COMMAND);
  });
});
