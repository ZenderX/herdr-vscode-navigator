import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { SubscriptionHandlers } from "../../../herdr/types";
import { createHerdrConnection } from "../../../vscode/herdrConnection";

function setup() {
  const handlers: SubscriptionHandlers[] = [];
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const calls = { firstDisconnect: 0, warned: 0, reconnected: 0, connected: 0 };
  const connection = createHerdrConnection({
    pipeName: () => "pipe",
    subscribe: (_pipe, _topics, h) => {
      handlers.push(h);
      return { dispose: () => undefined };
    },
    log: () => undefined,
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
    refreshStatus: () => undefined,
    host: { get: () => "yes" },
    autoFollowEnabled: () => true,
    requestHosting: () => Promise.resolve(),
    autoAllowed: () => true,
    confirmFollowHere: () => Promise.resolve(false),
    onFocusEvent: () => undefined,
    onEvent: () => undefined,
    onFirstDisconnect: () => void calls.firstDisconnect++,
    onReconnected: () => void calls.reconnected++,
    onConnected: () => void calls.connected++,
  });
  return { connection, handlers, timers, calls };
}

describe("herdrConnection", () => {
  it("shows the connection state, warns once while herdr stays unreachable, and runs the disconnect hook once per disconnected streak", () => {
    const t = setup();
    t.connection.start();
    const h = t.handlers[0];
    // A first connect is not a server restart; only a start after a lost socket is.
    h?.onStarted?.();
    assert.deepEqual([t.calls.connected, t.calls.reconnected], [1, 0]);
    h?.onDisconnected?.("refused");
    h?.onDisconnected?.("refused");
    assert.equal(t.calls.firstDisconnect, 1);
    assert.equal(t.timers.length, 1);
    t.timers[0]?.fn();
    assert.equal(t.calls.warned, 1);
    h?.onStarted?.();
    assert.equal(t.connection.isConnected(), true);
    assert.deepEqual([t.calls.connected, t.calls.reconnected], [1, 1]);
    assert.equal(t.timers[0]?.cleared, true);
    h?.onDisconnected?.("closed");
    assert.equal(t.calls.firstDisconnect, 2);
    assert.equal(t.connection.isConnected(), false);
  });
});
