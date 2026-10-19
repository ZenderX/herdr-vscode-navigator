import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { HostState } from "../../../hosting";
import type { SubscriptionHandlers } from "../../../herdr/types";
import { createHerdrConnection } from "../../../vscode/herdrConnection";

function setup(options: { host?: HostState; allowed?: boolean; recheckFails?: boolean } = {}) {
  const handlers: SubscriptionHandlers[] = [];
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const calls = { refresh: 0, firstDisconnect: 0, warned: 0, focus: 0, disposed: 0 };
  const statuses: boolean[] = [];
  const connection = createHerdrConnection({
    pipeName: () => "pipe",
    subscribe: (_pipe, _topics, h) => {
      handlers.push(h);
      return { dispose: () => void calls.disposed++ };
    },
    log: (_level, msg) => void logs.push(msg),
    clock: {
      setTimeout: (fn) => {
        timers.push({ fn, cleared: false });
        return timers.length - 1;
      },
      clearTimeout: (handle) => {
        const timer = timers[handle as number];
        if (timer) timer.cleared = true;
      },
    },
    warnUnreachable: () => void calls.warned++,
    refreshStatus: () => {
      calls.refresh++;
      statuses.push(connection.isConnected());
    },
    host: { get: () => options.host ?? "yes" },
    autoFollowEnabled: () => true,
    requestHosting: () => (options.recheckFails ? Promise.reject(new Error("scan failed")) : Promise.resolve()),
    autoAllowed: () => options.allowed ?? true,
    confirmFollowHere: () => Promise.resolve(false),
    onFocusEvent: () => void calls.focus++,
    onEvent: () => undefined,
    onFirstDisconnect: () => void calls.firstDisconnect++,
  });
  return { connection, handlers, logs, timers, calls, statuses };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("herdrConnection", () => {
  it("runs the disconnect hook once per disconnected streak, not on every failed reconnect", () => {
    const t = setup();
    t.connection.start();
    const h = t.handlers[0];
    h?.onDisconnected?.("refused");
    h?.onDisconnected?.("refused");
    h?.onDisconnected?.("refused");
    assert.equal(t.calls.firstDisconnect, 1);
    h?.onStarted?.();
    h?.onDisconnected?.("closed");
    assert.equal(t.calls.firstDisconnect, 2);
  });

  it("keeps the streak across a manual reconnect that fails again", () => {
    const t = setup();
    t.connection.start();
    t.handlers[0]?.onDisconnected?.("refused");
    t.connection.start();
    t.handlers[1]?.onDisconnected?.("refused");
    assert.equal(t.calls.firstDisconnect, 1);
  });

  it("shows disconnected as soon as a subscription is restarted", () => {
    const t = setup();
    t.connection.start();
    t.handlers[0]?.onStarted?.();
    assert.equal(t.connection.isConnected(), true);
    t.statuses.length = 0;
    t.connection.start();
    assert.equal(t.connection.isConnected(), false);
    assert.deepEqual(t.statuses, [false]);
    assert.equal(t.calls.disposed, 1);
  });

  it("reports disconnected after stop so a late status refresh cannot restart polling", () => {
    const t = setup();
    t.connection.start();
    t.handlers[0]?.onStarted?.();
    t.connection.stop();
    assert.equal(t.connection.isConnected(), false);
  });

  it("warns once when herdr stays unreachable and cancels the warning on connect", () => {
    const t = setup();
    t.connection.start();
    t.handlers[0]?.onDisconnected?.("refused");
    t.handlers[0]?.onDisconnected?.("refused");
    assert.equal(t.timers.length, 1);
    t.timers[0]?.fn();
    assert.equal(t.calls.warned, 1);
    t.handlers[0]?.onStarted?.();
    assert.equal(t.timers[0]?.cleared, true);
  });

  it("logs instead of rejecting when the hosting recheck fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const t = setup({ allowed: false, host: "no", recheckFails: true });
      t.connection.whenHosting(() => assert.fail("must not follow after a failed recheck"));
      const hosted = setup({ recheckFails: true });
      hosted.connection.whenHosting(() => undefined);
      await tick();
      await tick();
      assert.deepEqual(rejections, []);
      assert.match(t.logs.join("\n"), /hosting recheck: scan failed/);
      assert.match(hosted.logs.join("\n"), /hosting recheck: scan failed/);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
