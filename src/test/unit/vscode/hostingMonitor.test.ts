import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HostState } from "../../../hosting";
import { COMMAND_START_SETTLE_MS, HostingMonitor, createCommandStartTrigger } from "../../../vscode/hostingMonitor";
import type { HostingResult } from "../../../vscode/hostingMonitor";

interface PendingScan {
  terminals: readonly string[];
  resolve: (state: HostState, clientPids?: number[]) => void;
}

function setup(initial: string[]) {
  const terminals = [...initial];
  const scans: PendingScan[] = [];
  const published: HostingResult<string>[] = [];
  let time = 0;
  const monitor = new HostingMonitor<string>({
    terminals: () => terminals,
    scan: (seen) =>
      new Promise((resolve) => {
        scans.push({ terminals: seen, resolve: (state, clientPids = []) => resolve({ state, clientPids }) });
      }),
    now: () => time,
  });
  monitor.subscribe((result) => void published.push(result));
  return { monitor, terminals, scans, published, advance: (ms: number) => void (time += ms) };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("HostingMonitor", () => {
  it("never publishes a pre-terminal scan after a terminal opened, even to joined requests", async () => {
    const m = setup(["a"]);
    const first = m.monitor.request(true);
    const second = m.monitor.request(true);
    m.terminals.push("b");
    m.scans[0]?.resolve("no");
    await tick();
    assert.equal(m.published.length, 0);
    assert.deepEqual(m.scans[1]?.terminals, ["a", "b"]);
    m.scans[1]?.resolve("yes", [7]);
    const [one, two] = await Promise.all([first, second]);
    assert.equal(m.published.length, 1);
    assert.equal(one.state, "yes");
    assert.equal(two, one);
    assert.deepEqual(one.terminalsScanned, ["a", "b"]);
    assert.deepEqual(one.clientPids, [7]);
  });

  it("publishes unknown when coverage cannot be reached", async () => {
    const m = setup(["a"]);
    const request = m.monitor.request(true);
    for (let i = 0; i < 3; i++) {
      m.terminals.push(`t${i}`);
      m.scans[i]?.resolve("yes", [1]);
      await tick();
    }
    const result = await request;
    assert.equal(m.scans.length, 3);
    assert.equal(result.state, "unknown");
    assert.deepEqual(result.clientPids, []);
    assert.deepEqual(m.published.map(({ state }) => state), ["unknown"]);
  });

  it("delivers a gain found by a lazy recheck to subscribers", async () => {
    const m = setup(["a"]);
    const first = m.monitor.request();
    m.scans[0]?.resolve("no");
    await first;
    m.advance(31_000);
    const lazy = m.monitor.request();
    m.scans[1]?.resolve("yes", [9]);
    await lazy;
    assert.deepEqual(m.published.map(({ state }) => state), ["no", "yes"]);
    assert.deepEqual(m.published[1]?.clientPids, [9]);
  });

  it("stops publishing to subscribers once disposed", async () => {
    const m = setup(["a"]);
    const request = m.monitor.request(true);
    m.monitor.dispose();
    m.scans[0]?.resolve("yes", [3]);
    const result = await request;
    assert.equal(result.state, "yes");
    assert.deepEqual(m.published, []);
  });

  it("serves the cache within its lifetime unless forced or a terminal is new", async () => {
    const m = setup(["a"]);
    const first = m.monitor.request();
    m.scans[0]?.resolve("no");
    await first;
    m.advance(4000);
    await m.monitor.request();
    assert.equal(m.scans.length, 1);
    m.terminals.push("b");
    const covering = m.monitor.request();
    assert.equal(m.scans.length, 2);
    m.scans[1]?.resolve("no");
    await covering;
    const forced = m.monitor.request(true);
    assert.equal(m.scans.length, 3);
    m.scans[2]?.resolve("no");
    await forced;
  });

  for (const state of ["no", "yes"] as const) {
    it(`rescans lazily only after 30 s once ${state}`, async () => {
      const m = setup(["a"]);
      const first = m.monitor.request();
      m.scans[0]?.resolve(state);
      await first;
      // Elapsed since the scan: 5 s, 10 s, 29 s.
      for (const step of [5_000, 5_000, 19_000]) {
        m.advance(step);
        await m.monitor.request();
      }
      assert.equal(m.scans.length, 1);
      m.advance(2_000);
      const later = m.monitor.request();
      assert.equal(m.scans.length, 2);
      m.scans[1]?.resolve(state);
      await later;
    });
  }

  it("retries an unknown result after 5 s", async () => {
    const m = setup(["a"]);
    const first = m.monitor.request();
    m.scans[0]?.resolve("unknown");
    await first;
    m.advance(6_000);
    void m.monitor.request();
    assert.equal(m.scans.length, 2);
  });

  it("forces a scan at once regardless of a fresh result", async () => {
    const m = setup(["a"]);
    const first = m.monitor.request();
    m.scans[0]?.resolve("no");
    await first;
    void m.monitor.request(true);
    assert.equal(m.scans.length, 2);
  });
});

describe("createCommandStartTrigger", () => {
  function trigger(initial: boolean) {
    let hosting = initial;
    const timers: Array<() => void> = [];
    let scans = 0;
    let cleared = 0;
    let delay = 0;
    const t = createCommandStartTrigger({
      isHosting: () => hosting,
      scan: () => void scans++,
      setTimer: (fn, ms) => {
        delay = ms;
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => void cleared++,
    });
    return { t, timers, scans: () => scans, cleared: () => cleared, delay: () => delay, setHosting: (v: boolean) => void (hosting = v) };
  }

  it("coalesces a burst of command starts into one scan after the settle delay", () => {
    const x = trigger(false);
    x.t.onCommandStart();
    x.t.onCommandStart();
    x.t.onCommandStart();
    assert.equal(x.timers.length, 1);
    assert.equal(x.delay(), COMMAND_START_SETTLE_MS);
    assert.equal(x.scans(), 0);
    x.timers[0]?.();
    assert.equal(x.scans(), 1);
    x.t.onCommandStart();
    assert.equal(x.timers.length, 2);
  });

  it("ignores command starts in a hosting window", () => {
    const x = trigger(true);
    x.t.onCommandStart();
    assert.equal(x.timers.length, 0);
    assert.equal(x.scans(), 0);
  });

  it("skips the scan when the window started hosting before the timer fired", () => {
    const x = trigger(false);
    x.t.onCommandStart();
    x.setHosting(true);
    x.timers[0]?.();
    assert.equal(x.scans(), 0);
  });

  it("cancel drops a pending scan", () => {
    const x = trigger(false);
    x.t.onCommandStart();
    x.t.cancel();
    assert.equal(x.cleared(), 1);
  });
});
