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
    x.setHosting(true);
    x.t.onCommandStart();
    assert.equal(x.timers.length, 2, "a hosting window ignores command starts");
  });
});
