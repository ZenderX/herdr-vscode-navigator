import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HostState } from "../../../hosting";
import { createFollowConsent } from "../../../vscode/followConsent";

function setup(host: HostState = "unknown") {
  const workspace = new Map<string, unknown>();
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => Promise.resolve(void store.set(key, value)),
  });
  const prompts: string[] = [];
  const answers: Array<string | undefined> = [];
  let release: (() => void) | undefined;
  const consent = createFollowConsent({
    host: { get: () => host },
    workspaceState: memento(workspace),
    askModal: async (message) => {
      prompts.push(message);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return answers.shift();
    },
    requestHosting: () => Promise.resolve(),
    refreshStatus: () => undefined,
  });
  return { consent, workspace, prompts, answers, answer: () => release?.() };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("followConsent", () => {
  it("never prompts in a window known not to host herdr, and asks an undetectable window once, remembering a yes", async () => {
    const known = setup("no");
    assert.equal(await known.consent.guardAuto(true), false);
    assert.deepEqual(known.prompts, []);

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
});
