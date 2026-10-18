import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HostState } from "../../../hosting";
import { HostingMonitor } from "../../../vscode/hostingMonitor";
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
    m.advance(6000);
    const lazy = m.monitor.request();
    m.scans[1]?.resolve("yes", [9]);
    await lazy;
    assert.deepEqual(m.published.map(({ state }) => state), ["no", "yes"]);
    assert.deepEqual(m.published[1]?.clientPids, [9]);
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
});
