import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { HERDR_INSTALL_URL, HerdrPresence, handleNotInstalledClick, showsNotInstalled } from "../../../launch/herdrPresence";
import type { HerdrPresenceState } from "../../../launch/herdrPresence";

function setup(initial: string | undefined) {
  let result = initial;
  let calls = 0;
  let fail = false;
  let release: (() => void) | undefined;
  let hold = false;
  let focus: (focused: boolean) => void = () => {};
  const logs: string[] = [];
  const presence = new HerdrPresence({
    resolve: async () => {
      calls++;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      if (fail) throw new Error("boom");
      return result;
    },
    subscribeFocus: (listener) => {
      focus = listener;
      return { dispose() {} };
    },
    log: (_level, msg) => void logs.push(msg),
  });
  return {
    presence,
    logs,
    calls: () => calls,
    focus: (focused: boolean) => focus(focused),
    set: (value: string | undefined) => void (result = value),
    failNext: () => void (fail = true),
    hold: () => void (hold = true),
    release: () => {
      hold = false;
      release?.();
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("HerdrPresence", () => {
  it("records the resolved path and notifies on a transition", async () => {
    const t = setup("/bin/herdr");
    const seen: HerdrPresenceState[] = [];
    t.presence.onChange((state) => void seen.push(state));
    await t.presence.recheck();
    assert.deepEqual(t.presence.get(), { state: "found", path: "/bin/herdr" });
    assert.deepEqual(seen, [{ state: "found", path: "/bin/herdr" }]);
    await t.presence.recheck();
    assert.equal(seen.length, 1);
  });

  it("re-checks on focus gain while not found, so an install made elsewhere is noticed", async () => {
    const t = setup(undefined);
    await t.presence.recheck();
    t.set("/bin/herdr");
    t.focus(true);
    await flush();
    assert.equal(t.presence.get().state, "found");
    assert.equal(t.calls(), 2);
  });

  it("ignores focus loss", async () => {
    const t = setup(undefined);
    await t.presence.recheck();
    t.focus(false);
    await flush();
    assert.equal(t.calls(), 1);
  });

  it("does not re-resolve on focus gain once herdr was found", async () => {
    const t = setup("/bin/herdr");
    await t.presence.recheck();
    t.focus(true);
    await flush();
    assert.equal(t.calls(), 1);
  });

  it("coalesces overlapping re-checks into one resolution", async () => {
    const t = setup("/bin/herdr");
    t.hold();
    const first = t.presence.recheck();
    const second = t.presence.recheck();
    await flush();
    t.release();
    await Promise.all([first, second]);
    assert.equal(t.calls(), 1);
    await t.presence.recheck();
    assert.equal(t.calls(), 2);
  });

  it("keeps the previous state and logs when resolution throws", async () => {
    const t = setup("/bin/herdr");
    await t.presence.recheck();
    t.failNext();
    await t.presence.recheck();
    assert.equal(t.presence.get().state, "found");
    assert.equal(t.logs.length, 1);
  });

  it("starts unknown, not not-found, until the first resolution completes", async () => {
    const t = setup(undefined);
    assert.deepEqual(t.presence.get(), { state: "unknown" });
    await t.presence.recheck();
    assert.deepEqual(t.presence.get(), { state: "not-found" });
  });

  it("stays unknown when the first resolution throws, and retries on focus gain", async () => {
    const t = setup("/bin/herdr");
    t.failNext();
    await t.presence.recheck();
    assert.deepEqual(t.presence.get(), { state: "unknown" });
    t.focus(true);
    await flush();
    assert.equal(t.calls(), 2);
  });

  it("never resolves just from being read", async () => {
    const t = setup("/bin/herdr");
    await t.presence.recheck();
    for (let i = 0; i < 5; i++) t.presence.get();
    await flush();
    assert.equal(t.calls(), 1);
  });
});

describe("showsNotInstalled", () => {
  it("keeps the installed look while unknown, so startup never flashes 'not installed'", () => {
    assert.equal(showsNotInstalled({ state: "unknown" }), false);
  });

  it("keeps the installed look when found", () => {
    assert.equal(showsNotInstalled({ state: "found", path: "/bin/herdr" }), false);
  });

  it("shows not installed only for a confirmed miss", () => {
    assert.equal(showsNotInstalled({ state: "not-found" }), true);
  });
});

describe("handleNotInstalledClick", () => {
  function click(state: HerdrPresenceState) {
    const opened: string[] = [];
    let installedRuns = 0;
    const done = handleNotInstalledClick({
      recheck: async () => state,
      runInstalled: async () => void installedRuns++,
      openExternal: async (url) => void opened.push(url),
    });
    return { done, opened, runs: () => installedRuns };
  }

  it("opens exactly the install page while herdr is still missing", async () => {
    const c = click({ state: "not-found" });
    await c.done;
    assert.deepEqual(c.opened, [HERDR_INSTALL_URL]);
    assert.equal(HERDR_INSTALL_URL, "https://herdr.dev/docs/install/");
    assert.equal(c.runs(), 0);
  });

  it("runs the installed behaviour and opens no URL when the re-check finds herdr", async () => {
    const c = click({ state: "found", path: "/bin/herdr" });
    await c.done;
    assert.equal(c.runs(), 1);
    assert.deepEqual(c.opened, []);
  });
});
