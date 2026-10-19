import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { FOLDER_SWITCH_CONFIRM } from "../../../follow/switchFolder";
import type { HostState } from "../../../hosting";
import { createFollowConsent } from "../../../vscode/followConsent";

function setup(options: { host?: HostState; confirmed?: boolean } = {}) {
  let host: HostState = options.host ?? "unknown";
  const workspace = new Map<string, unknown>();
  const global = new Map<string, unknown>();
  if (options.confirmed !== undefined) workspace.set("herdrNavigator.followHere", options.confirmed);
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => Promise.resolve(void store.set(key, value)),
  });
  const prompts: string[] = [];
  const answers: Array<string | undefined> = [];
  const hostingRequests: boolean[] = [];
  let refreshes = 0;
  let release: (() => void) | undefined;
  const consent = createFollowConsent({
    host: { get: () => host },
    workspaceState: memento(workspace),
    globalState: memento(global),
    askModal: async (message) => {
      prompts.push(message);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return answers.shift();
    },
    followMode: () => "workspace",
    requestHosting: (force) => Promise.resolve(void hostingRequests.push(force)),
    refreshStatus: () => void refreshes++,
  });
  return {
    consent,
    workspace,
    global,
    prompts,
    answers,
    hostingRequests,
    refreshes: () => refreshes,
    setHost: (next: HostState) => void (host = next),
    answer: () => release?.(),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("followConsent", () => {
  it("allows automatic plans only for a hosting window or a confirmed undetectable one", () => {
    assert.equal(setup({ host: "yes" }).consent.autoAllowed(), true);
    assert.equal(setup({ host: "no", confirmed: true }).consent.autoAllowed(), false);
    assert.equal(setup({ host: "unknown" }).consent.autoAllowed(), false);
    assert.equal(setup({ host: "unknown", confirmed: true }).consent.autoAllowed(), true);
  });

  it("never prompts when hosting is known, and scans only when forced", async () => {
    const t = setup({ host: "no" });
    assert.equal(await t.consent.guardAuto(false), false);
    assert.equal(await t.consent.guardAuto(true), false);
    assert.deepEqual(t.hostingRequests, [false, true]);
    assert.deepEqual(t.prompts, []);
  });

  it("lets an explicit Follow Now bypass the guard", async () => {
    const t = setup({ host: "no" });
    t.consent.setManualFollow(true);
    assert.equal(await t.consent.guardAuto(true), true);
    assert.deepEqual(t.hostingRequests, []);
  });

  it("asks once for concurrent plans and remembers a yes", async () => {
    const t = setup();
    t.answers.push("Follow herdr in this window");
    const first = t.consent.guardAuto(false);
    const second = t.consent.guardAuto(false);
    await tick();
    t.answer();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(t.prompts.length, 1);
    assert.equal(t.workspace.get("herdrNavigator.followHere"), true);
    assert.equal(await t.consent.guardAuto(false), true);
    assert.equal(t.prompts.length, 1);
  });

  it("treats Escape as a decline until reset, and asks again afterwards", async () => {
    const t = setup();
    t.answers.push(undefined);
    const dismissed = t.consent.confirmFollowHere();
    await tick();
    t.answer();
    assert.equal(await dismissed, false);
    assert.equal(await t.consent.confirmFollowHere(), false);
    assert.equal(t.prompts.length, 1);
    assert.match(t.consent.suppressionReason(), /run Reconnect to be asked again/);

    await t.consent.reset();
    t.answers.push("Follow herdr in this window");
    const again = t.consent.confirmFollowHere();
    await tick();
    t.answer();
    assert.equal(await again, true);
    assert.equal(t.prompts.length, 2);
  });

  it("can ask again after the prompt itself failed", async () => {
    let asked = 0;
    // A rejected prompt must not leave the in-flight marker behind.
    const broken = createFollowConsent({
      host: { get: () => "unknown" },
      workspaceState: { get: () => undefined, update: () => Promise.resolve() },
      globalState: { get: () => undefined, update: () => Promise.resolve() },
      askModal: () => {
        asked++;
        return Promise.reject(new Error("prompt failed"));
      },
      followMode: () => "workspace",
      requestHosting: () => Promise.resolve(),
      refreshStatus: () => undefined,
    });
    await assert.rejects(broken.confirmFollowHere(), /prompt failed/);
    await assert.rejects(broken.confirmFollowHere(), /prompt failed/);
    assert.equal(asked, 2);
  });

  it("shows the folder-switch notice until the user accepts it once", async () => {
    const t = setup();
    t.answers.push(undefined);
    const declined = t.consent.confirmFolderSwitch();
    await tick();
    t.answer();
    assert.equal(await declined, false);
    assert.equal(t.global.get("herdrNavigator.folderSwitchNoticeShown"), undefined);

    t.answers.push(FOLDER_SWITCH_CONFIRM);
    const accepted = t.consent.confirmFolderSwitch();
    await tick();
    t.answer();
    assert.equal(await accepted, true);
    assert.equal(await t.consent.confirmFolderSwitch(), true);
    assert.equal(t.prompts.length, 2);
  });

  it("adopts a confirmation that travelled with a pending intent", async () => {
    const t = setup();
    await t.consent.adopt();
    assert.equal(t.consent.confirmedHere(), true);
    assert.equal(t.workspace.get("herdrNavigator.followHere"), true);
  });
});
