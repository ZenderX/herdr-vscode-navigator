import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { HERDR_INSTALL_URL, HerdrPresence, handleNotInstalledClick, showsNotInstalled } from "../../../launch/herdrPresence";
import type { HerdrPresenceState } from "../../../launch/herdrPresence";

function setup(initial: string | undefined) {
  let result = initial;
  let calls = 0;
  let focus: (focused: boolean) => void = () => {};
  const presence = new HerdrPresence({
    resolve: async () => {
      calls++;
      return result;
    },
    subscribeFocus: (listener) => {
      focus = listener;
      return { dispose() {} };
    },
    log: () => undefined,
  });
  return { presence, calls: () => calls, focus: (focused: boolean) => focus(focused), set: (value: string | undefined) => void (result = value) };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("HerdrPresence", () => {
  it("starts unknown so startup never flashes 'not installed', then shows not installed only for a confirmed miss", async () => {
    const t = setup(undefined);
    const seen: HerdrPresenceState[] = [];
    t.presence.onChange((state) => void seen.push(state));
    assert.equal(showsNotInstalled(t.presence.get()), false);
    await t.presence.recheck();
    assert.deepEqual(t.presence.get(), { state: "not-found" });
    assert.equal(showsNotInstalled(t.presence.get()), true);
    assert.deepEqual(seen, [{ state: "not-found" }]);
  });

  it("re-checks on focus gain while not found, so an install made elsewhere is noticed and the click stops opening the install page", async () => {
    const t = setup(undefined);
    await t.presence.recheck();
    t.set("/bin/herdr");
    t.focus(true);
    await flush();
    assert.deepEqual(t.presence.get(), { state: "found", path: "/bin/herdr" });
    t.focus(true);
    await flush();
    assert.equal(t.calls(), 2);

    const opened: string[] = [];
    let installedRuns = 0;
    const deps = { runInstalled: async () => void installedRuns++, openExternal: async (url: string) => void opened.push(url) };
    await handleNotInstalledClick({ ...deps, recheck: async () => ({ state: "not-found" }) });
    await handleNotInstalledClick({ ...deps, recheck: async () => t.presence.get() });
    assert.deepEqual(opened, [HERDR_INSTALL_URL]);
    assert.equal(installedRuns, 1);
  });
});
