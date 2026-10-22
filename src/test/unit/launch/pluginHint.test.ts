import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HerdrPresenceState } from "../../../launch/herdrPresence";
import type { PluginState } from "../../../launch/pluginDetect";
import {
  HINT_DISMISS,
  HINT_INSTALL,
  HINT_LEARN_MORE,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_README_URL,
  PluginHint,
  handlePluginHintClick,
  installPluginInTerminal,
  shouldShowHint,
} from "../../../launch/pluginHint";

const found: HerdrPresenceState = { state: "found", path: "/bin/herdr" };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(initial: { presence?: HerdrPresenceState; plugin?: PluginState; dismissed?: boolean } = {}) {
  let presence = initial.presence ?? found;
  let plugin = initial.plugin ?? "absent";
  let dismissed = initial.dismissed ?? false;
  let detects = 0;
  let release: (() => void) | undefined;
  let hold = false;
  let visible: boolean | undefined;
  const persisted: boolean[] = [];
  let emit: (state: HerdrPresenceState) => void = () => {};
  const hint = new PluginHint({
    presence: {
      get: () => presence,
      onChange: (listener) => {
        emit = listener;
        return { dispose() {} };
      },
    },
    detect: async () => {
      detects++;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return plugin;
    },
    isDismissed: () => dismissed,
    setDismissed: async () => {
      dismissed = true;
      persisted.push(true);
    },
    setVisible: (value) => void (visible = value),
  });
  return {
    hint,
    visible: () => visible,
    detects: () => detects,
    persisted,
    setPlugin: (value: PluginState) => void (plugin = value),
    setPresence: (value: HerdrPresenceState) => {
      presence = value;
      emit(value);
    },
    hold: () => void (hold = true),
    release: () => {
      hold = false;
      release?.();
    },
  };
}

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
  it("shows when the plugin is absent", async () => {
    const t = setup();
    await t.hint.refresh();
    assert.equal(t.visible(), true);
  });

  it("shows no hint when detection is unknown", async () => {
    const t = setup({ plugin: "unknown" });
    await t.hint.refresh();
    assert.equal(t.visible(), false);
  });

  it("hides when herdr is not found even though detection says missing", async () => {
    const t = setup({ presence: { state: "not-found" } });
    await t.hint.refresh();
    assert.equal(t.visible(), false);
    assert.equal(t.detects(), 0);
  });

  it("hides at once when presence drops to not-found", async () => {
    const t = setup();
    await t.hint.refresh();
    t.setPresence({ state: "not-found" });
    assert.equal(t.visible(), false);
  });

  it("stays hidden when dismissed", async () => {
    const t = setup({ dismissed: true });
    await t.hint.refresh();
    assert.equal(t.visible(), false);
  });

  it("dismiss persists the flag and hides immediately", async () => {
    const t = setup();
    await t.hint.refresh();
    await t.hint.dismiss();
    assert.deepEqual(t.persisted, [true]);
    assert.equal(t.visible(), false);
  });

  it("hides after detection reports the plugin installed and enabled", async () => {
    const t = setup();
    await t.hint.refresh();
    t.setPlugin("present");
    await t.hint.refresh();
    assert.equal(t.visible(), false);
  });

  it("detects when presence flips to found", async () => {
    const t = setup();
    t.setPresence(found);
    await flush();
    assert.equal(t.detects(), 1);
    assert.equal(t.visible(), true);
  });

  it("does not start a second detection while one is in flight", async () => {
    const t = setup();
    t.hold();
    const first = t.hint.refresh();
    t.setPresence(found);
    const second = t.hint.refresh();
    await flush();
    t.release();
    await Promise.all([first, second]);
    assert.equal(t.detects(), 1);
  });

  it("never detects just from being constructed or read", async () => {
    const t = setup();
    await flush();
    assert.equal(t.detects(), 0);
  });
});

describe("installPluginInTerminal", () => {
  function terminals() {
    const sent: { text: string; execute: boolean | undefined }[] = [];
    let shown = 0;
    let onClose: (terminal: object) => void = () => {};
    let refreshes = 0;
    const mine = {
      show: () => void shown++,
      sendText: (text: string, execute?: boolean) => void sent.push({ text, execute }),
    };
    const other = { show() {}, sendText() {} };
    installPluginInTerminal({
      createTerminal: () => mine,
      onDidCloseTerminal: (listener) => {
        onClose = listener as (terminal: object) => void;
        return { dispose() {} };
      },
      refresh: async () => void refreshes++,
    });
    return { sent, shown: () => shown, close: (terminal: "mine" | "other") => onClose(terminal === "mine" ? mine : other), refreshes: () => refreshes };
  }

  it("types the install command into a shown terminal without --yes", () => {
    const t = terminals();
    assert.equal(t.shown(), 1);
    assert.deepEqual(t.sent, [{ text: "herdr plugin install ZenderX/herdr-vscode-navigator/plugin", execute: true }]);
    assert.equal(PLUGIN_INSTALL_COMMAND.includes("--yes"), false);
  });

  it("re-detects when its own terminal closes, not when another does", () => {
    const t = terminals();
    t.close("other");
    assert.equal(t.refreshes(), 0);
    t.close("mine");
    assert.equal(t.refreshes(), 1);
  });
});

describe("handlePluginHintClick", () => {
  function click(choice: string | undefined) {
    const calls: string[] = [];
    const messages: string[][] = [];
    const done = handlePluginHintClick({
      showMessage: async (_message, ...items) => {
        messages.push(items);
        return choice;
      },
      openExternal: async (url) => void calls.push(`open:${url}`),
      install: () => void calls.push("install"),
      dismiss: async () => void calls.push("dismiss"),
    });
    return { done, calls, messages };
  }

  it("offers install, learn more and a hide choice", async () => {
    const c = click(undefined);
    await c.done;
    assert.deepEqual(c.messages, [[HINT_INSTALL, HINT_LEARN_MORE, HINT_DISMISS]]);
    assert.deepEqual(c.calls, []);
  });

  it("routes each choice to its own action", async () => {
    const install = click(HINT_INSTALL);
    await install.done;
    assert.deepEqual(install.calls, ["install"]);
    const learn = click(HINT_LEARN_MORE);
    await learn.done;
    assert.deepEqual(learn.calls, [`open:${PLUGIN_README_URL}`]);
    const dismiss = click(HINT_DISMISS);
    await dismiss.done;
    assert.deepEqual(dismiss.calls, ["dismiss"]);
  });
});
