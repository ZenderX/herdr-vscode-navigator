import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { INSTALL_COMMAND, LAUNCH_COMMAND, MAIN_ITEM_PRIORITY, PLUGIN_HINT_PRIORITY, StatusBar, TOGGLE_COMMAND } from "../../../vscode/statusBar";
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

describe("StatusBar main item", () => {
  it("shows the auto-follow eye and toggles it while herdr runs, offers launch otherwise, and the install page when herdr is missing", () => {
    const item = fakeItem();
    const bar = new StatusBar(item, themeColor);
    bar.update(true, true, "/proj/app", true);
    assert.match(item.text, /^\$\(eye\) herdr: app/);
    assert.equal(item.color, undefined);
    assert.equal(item.command, TOGGLE_COMMAND);

    bar.update(false, false, null, false);
    assert.match(item.text, /^\$\(eye-closed\)/);
    assert.deepEqual(item.color, { id: "disabledForeground" });
    assert.equal(item.command, LAUNCH_COMMAND);
    assert.doesNotMatch(item.text, /not installed/);

    bar.update(false, true, null, false, undefined, false);
    assert.equal(item.text, "$(eye) herdr: not installed");
    assert.equal(item.command, INSTALL_COMMAND);
  });
});

describe("StatusBar item priorities", () => {
  it("place the plugin hint directly right of the main item, with no default or integer priority able to land between them", () => {
    assert.ok(PLUGIN_HINT_PRIORITY < MAIN_ITEM_PRIORITY, "a lower Left priority sits further right");
    assert.ok(MAIN_ITEM_PRIORITY - PLUGIN_HINT_PRIORITY < 1);
    // The smallest integer at or above the hint must already lie above the main item.
    assert.ok(Math.ceil(PLUGIN_HINT_PRIORITY) > MAIN_ITEM_PRIORITY, "an integer priority lies in [hint, main]");
  });
});
