import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HerdrPresenceState } from "../../../launch/herdrPresence";
import type { PluginState } from "../../../launch/pluginDetect";
import {
  HINT_DISMISS,
  HINT_INSTALL,
  HINT_LEARN_MORE,
  PLUGIN_README_URL,
  PluginHint,
  handlePluginHintClick,
  installPluginInTerminal,
  shouldShowHint,
} from "../../../launch/pluginHint";

const found: HerdrPresenceState = { state: "found", path: "/bin/herdr" };

describe("shouldShowHint", () => {
  it("shows only for found herdr, no dismissal and an absent plugin", () => {
    assert.equal(shouldShowHint(found, false, "absent"), true);
    assert.equal(shouldShowHint(found, false, "present"), false);
    assert.equal(shouldShowHint(found, false, "unknown"), false);
    assert.equal(shouldShowHint({ state: "not-found" }, false, "absent"), false);
    assert.equal(shouldShowHint({ state: "unknown" }, false, "absent"), false);
    assert.equal(shouldShowHint(found, true, "absent"), false);
  });
});

describe("PluginHint", () => {
  it("shows while the plugin is absent, hides once it is installed, and a dismissal persists and hides at once", async () => {
    let plugin: PluginState = "absent";
    let dismissed = false;
    let visible: boolean | undefined;
    const persisted: boolean[] = [];
    const hint = new PluginHint({
      presence: { get: () => found, onChange: () => ({ dispose() {} }) },
      detect: async () => plugin,
      isDismissed: () => dismissed,
      setDismissed: async () => {
        dismissed = true;
        persisted.push(true);
      },
      setVisible: (value) => void (visible = value),
    });
    assert.equal(hint.pluginState(), "unknown");
    await hint.refresh();
    assert.equal(visible, true);
    assert.equal(hint.pluginState(), "absent");
    plugin = "present";
    await hint.refresh();
    assert.equal(visible, false);
    // The extension's cwd-return defers to the plugin on this same detection, without a second `plugin list`.
    assert.equal(hint.pluginState(), "present");
    plugin = "absent";
    await hint.refresh();
    await hint.dismiss();
    assert.deepEqual(persisted, [true]);
    assert.equal(visible, false);
  });
});

describe("installPluginInTerminal", () => {
  it("types the install command, without --yes, into a shown terminal and re-detects when that terminal closes", () => {
    const sent: { text: string; execute: boolean | undefined }[] = [];
    let shown = 0;
    let refreshes = 0;
    let onClose: (terminal: object) => void = () => {};
    const mine = { show: () => void shown++, sendText: (text: string, execute?: boolean) => void sent.push({ text, execute }) };
    installPluginInTerminal({
      createTerminal: () => mine,
      onDidCloseTerminal: (listener) => {
        onClose = listener as (terminal: object) => void;
        return { dispose() {} };
      },
      refresh: async () => void refreshes++,
    });
    assert.equal(shown, 1);
    assert.deepEqual(sent, [{ text: "herdr plugin install ZenderX/herdr-vscode-navigator/plugin", execute: true }]);
    onClose({ show() {}, sendText() {} });
    assert.equal(refreshes, 0);
    onClose(mine);
    assert.equal(refreshes, 1);
  });
});

describe("handlePluginHintClick", () => {
  it("offers install, learn more and hide, and routes each choice to its own action", async () => {
    const run = async (choice: string | undefined) => {
      const calls: string[] = [];
      const offered: string[][] = [];
      await handlePluginHintClick({
        showMessage: async (_message, ...items) => (offered.push(items), choice),
        openExternal: async (url) => void calls.push(`open:${url}`),
        install: () => void calls.push("install"),
        dismiss: async () => void calls.push("dismiss"),
      });
      return { calls, offered };
    };
    assert.deepEqual((await run(undefined)).offered, [[HINT_INSTALL, HINT_LEARN_MORE, HINT_DISMISS]]);
    assert.deepEqual((await run(undefined)).calls, []);
    assert.deepEqual((await run(HINT_INSTALL)).calls, ["install"]);
    assert.deepEqual((await run(HINT_LEARN_MORE)).calls, [`open:${PLUGIN_README_URL}`]);
    assert.deepEqual((await run(HINT_DISMISS)).calls, ["dismiss"]);
  });
});
