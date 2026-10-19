import * as assert from "node:assert/strict";
import * as net from "node:net";
import { findWorkspaceIdByLabel, HerdrClient } from "../../../herdr/client";
import { LineSplitter } from "../../../herdr/framing";
import { resolvePipeName } from "../../../herdr/pipe";
import type { HerdrEvent, PaneInfo, SessionSnapshot } from "../../../herdr/types";

let serverCounter = 0;

interface FakeServer {
  pipeName: string;
  connections: net.Socket[];
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

type Handler = (request: Record<string, unknown>, socket: net.Socket) => void;

async function startServer(handler: Handler): Promise<FakeServer> {
  serverCounter += 1;
  const pipeName = `\\\\.\\pipe\\herdr-navigator-test-${process.pid}-${serverCounter}`;
  const connections: net.Socket[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    const splitter = new LineSplitter();
    socket.on("data", (chunk) => {
      for (const line of splitter.push(chunk)) {
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        handler(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipeName, resolve));
  return {
    pipeName,
    connections,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        connections.forEach((c) => c.destroy());
        server.close(() => resolve());
      }),
  };
}

const reply = (socket: net.Socket, id: unknown, result: unknown): boolean =>
  socket.write(`${JSON.stringify({ id, result })}\n`);

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("HerdrClient", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  describe("request", () => {
    it("round-trips ping", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "pong", version: "0.9.5", protocol: 22 }));
      const result = (await new HerdrClient({ pipeName: server.pipeName }).request("ping", {})) as { protocol: number };
      assert.equal(result.protocol, 22);
    });

    it("rejects a snapshot whose workspaces or panes are not arrays", async () => {
      for (const snapshot of [{ panes: [] }, { workspaces: [] }, { panes: {}, workspaces: [] }, { panes: [], workspaces: "x" }]) {
        server = await startServer((req, socket) => reply(socket, req.id, { type: "session_snapshot", snapshot }));
        await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).snapshot(), /no snapshot/);
        await server.close();
      }
      server = undefined;
    });

    it("reassembles a response split across chunks", async () => {
      server = await startServer((req, socket) => {
        const line = `${JSON.stringify({ id: req.id, result: { type: "session_snapshot", snapshot: { panes: [], workspaces: [] } } })}\n`;
        socket.write(line.slice(0, 10));
        setTimeout(() => socket.write(line.slice(10)), 30);
      });
      const snapshot = await new HerdrClient({ pipeName: server.pipeName }).snapshot();
      assert.deepEqual(snapshot.panes, []);
    });

    it("rejects on an error response", async () => {
      server = await startServer((req, socket) =>
        socket.write(`${JSON.stringify({ id: req.id, error: { code: "bad", message: "nope" } })}\n`),
      );
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request("ping", {}), /bad: nope/);
    });

    it("rejects on timeout", async () => {
      server = await startServer(() => undefined);
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request("ping", {}, { timeoutMs: 50 }), /timed out/);
    });

    it("rejects when the socket closes without a response", async () => {
      server = await startServer((_req, socket) => socket.destroy());
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request("ping", {}), /closed/);
    });

    it("accepts pane.process_info and returns the shell pid", async () => {
      server = await startServer((req, socket) =>
        reply(socket, req.id, {
          type: "pane_process_info",
          process_info: { pane_id: "w1:p1", shell_pid: 4242, foreground_processes: [] },
        }),
      );
      const info = await new HerdrClient({ pipeName: server.pipeName }).processInfo("w1:p1");
      assert.equal(info.shell_pid, 4242);
      assert.deepEqual(server.requests[0].params, { pane_id: "w1:p1" });
    });

    it("rejects a pane.process_info response without shell_pid", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "pane_process_info", process_info: {} }));
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).processInfo("w1:p1"), /no shell_pid/);
    });

    it("focusWorkspace sends workspace.focus with workspace_id", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "workspace_info", workspace: { workspace_id: "w4" } }));
      await new HerdrClient({ pipeName: server.pipeName }).focusWorkspace("w4");
      assert.equal(server.requests[0].method, "workspace.focus");
      assert.deepEqual(server.requests[0].params, { workspace_id: "w4" });
    });

    it("focusWorkspace rejects on an error envelope", async () => {
      server = await startServer((req, socket) =>
        socket.write(`${JSON.stringify({ id: req.id, error: { code: "workspace_not_found", message: "gone" } })}\n`),
      );
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).focusWorkspace("w9"), /workspace_not_found: gone/);
    });

    it("still rejects write-style methods next to pane.process_info", async () => {
      server = await startServer(() => undefined);
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request("pane.close"), /not allowed/);
      assert.equal(server.connections.length, 0);
    });

    it("rejects a non-whitelisted method without connecting", async () => {
      server = await startServer(() => undefined);
      await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request("pane.send_text"), /not allowed/);
      assert.equal(server.connections.length, 0);
    });
  });

  describe("subscribe", () => {
    const backoff = { minMs: 10, maxMs: 40 };
    let sub: { dispose(): void } | undefined;

    beforeEach(() => {
      sub = undefined;
    });
    afterEach(() => sub?.dispose());

    it("acks then emits events in both wrapper shapes", async () => {
      server = await startServer((req, socket) => {
        reply(socket, req.id, { type: "subscription_started" });
        socket.write(`${JSON.stringify({ event: "pane_focused", data: { pane_id: "w1:p1" } })}\n`);
        reply(socket, "", { event: "tab_focused", data: { tab_id: "w1:t1" } });
      });
      const events: HerdrEvent[] = [];
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff }).subscribe(["pane.focused", "tab.focused"], {
        onStarted: () => (started += 1),
        onEvent: (e) => events.push(e),
      });
      await waitFor(() => events.length === 2);
      assert.equal(started, 1);
      assert.deepEqual(events, [
        { event: "pane_focused", data: { pane_id: "w1:p1" } },
        { event: "tab_focused", data: { tab_id: "w1:t1" } },
      ]);
      assert.deepEqual(server.requests[0].params, {
        subscriptions: [{ type: "pane.focused" }, { type: "tab.focused" }],
      });
    });

    it("reconnects and resubscribes after a server-side close", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "subscription_started" }));
      const reasons: string[] = [];
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff }).subscribe(["pane.focused"], {
        onStarted: () => (started += 1),
        onEvent: () => undefined,
        onDisconnected: (r) => reasons.push(r),
      });
      await waitFor(() => started === 1);
      server.connections[0].destroy();
      await waitFor(() => started === 2);
      assert.equal(reasons.length, 1);
      assert.equal(server.connections.length, 2);
      assert.equal(server.requests.filter((r) => r.method === "events.subscribe").length, 2);
    });

    it("treats events_lost as a disconnect and resubscribes", async () => {
      let first = true;
      server = await startServer((req, socket) => {
        reply(socket, req.id, { type: "subscription_started" });
        if (!first) return;
        first = false;
        socket.write(`${JSON.stringify({ id: "", error: { code: "events_lost", message: "overrun" } })}\n`);
      });
      const reasons: string[] = [];
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff }).subscribe(["pane.focused"], {
        onStarted: () => (started += 1),
        onEvent: () => undefined,
        onDisconnected: (r) => reasons.push(r),
      });
      await waitFor(() => started === 2);
      assert.match(reasons[0], /events_lost/);
    });

    it("reconnects when subscription_started never arrives", async () => {
      let connections = 0;
      server = await startServer((req, socket) => {
        connections += 1;
        if (connections === 2) reply(socket, req.id, { type: "subscription_started" });
      });
      const reasons: string[] = [];
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff, startTimeoutMs: 50 }).subscribe(["pane.focused"], {
        onStarted: () => (started += 1),
        onEvent: () => undefined,
        onDisconnected: (r) => reasons.push(r),
      });
      await waitFor(() => started === 1);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /no subscription_started/);
    });

    it("does not time out once the subscription started", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "subscription_started" }));
      const reasons: string[] = [];
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff, startTimeoutMs: 30 }).subscribe(["pane.focused"], {
        onStarted: () => (started += 1),
        onEvent: () => undefined,
        onDisconnected: (r) => reasons.push(r),
      });
      await waitFor(() => started === 1);
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(reasons, []);
    });

    it("stops reconnecting after dispose", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "subscription_started" }));
      let started = 0;
      sub = new HerdrClient({ pipeName: server.pipeName, backoff }).subscribe(["pane.focused"], {
        onStarted: () => (started += 1),
        onEvent: () => undefined,
      });
      await waitFor(() => started === 1);
      sub.dispose();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(server.connections.length, 1);
    });
  });
});

describe("LineSplitter", () => {
  it("joins partial chunks and drops blank lines and CRs", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push("ab"), []);
    assert.deepEqual(splitter.push("c\r\n\nd"), ["abc"]);
    assert.deepEqual(splitter.push("\n"), ["d"]);
  });

  it("throws when a pending partial line exceeds the cap, before more is buffered", () => {
    const splitter = new LineSplitter();
    const half = "x".repeat(3 * 1024 * 1024);
    assert.deepEqual(splitter.push(half), []);
    assert.throws(() => splitter.push(half), /exceeds/);
  });

  it("throws on an oversize complete line", () => {
    assert.throws(() => new LineSplitter().push(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`), /exceeds/);
  });
});

describe("findWorkspaceIdByLabel", () => {
  const pane = (workspace_id: string, cwd: string): PaneInfo => ({
    pane_id: `${workspace_id}:p1`,
    terminal_id: "t",
    workspace_id,
    tab_id: `${workspace_id}:t1`,
    focused: false,
    cwd,
  });
  const snapshot = (workspaces: Record<string, unknown>[], panes: PaneInfo[] = []): SessionSnapshot => ({
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    panes,
    tabs: [],
    workspaces,
  });

  it("matches the exact label", () => {
    const snap = snapshot([{ workspace_id: "w1", label: "alpha" }, { workspace_id: "w2", label: "Alpha" }]);
    assert.equal(findWorkspaceIdByLabel(snap, "Alpha"), "w2");
  });

  it("falls back to a case-insensitive match", () => {
    assert.equal(findWorkspaceIdByLabel(snapshot([{ workspace_id: "w3", label: "Docs" }]), "docs"), "w3");
  });

  it("returns undefined for a missing label", () => {
    assert.equal(findWorkspaceIdByLabel(snapshot([{ workspace_id: "w1", label: "a" }]), "b"), undefined);
  });

  it("disambiguates duplicate labels by the pane cwd matching lastFolder", () => {
    const snap = snapshot(
      [{ workspace_id: "w1", label: "x" }, { workspace_id: "w2", label: "x" }],
      [pane("w1", "C:\\a"), pane("w2", "C:\\b")],
    );
    assert.equal(findWorkspaceIdByLabel(snap, "x", "C:\\b"), "w2");
  });

  it("returns undefined for duplicates it cannot resolve", () => {
    const snap = snapshot(
      [{ workspace_id: "w1", label: "x" }, { workspace_id: "w2", label: "x" }],
      [pane("w1", "C:\\a"), pane("w2", "C:\\b")],
    );
    assert.equal(findWorkspaceIdByLabel(snap, "x"), undefined);
    assert.equal(findWorkspaceIdByLabel(snap, "x", "C:\\c"), undefined);
  });
});

describe("resolvePipeName", () => {
  it("prefers override, then env, then APPDATA, and keeps an existing prefix", () => {
    const env = { HERDR_SOCKET_PATH: "C:\\env\\h.sock", APPDATA: "C:\\Users\\x\\AppData\\Roaming" };
    assert.equal(resolvePipeName("C:\\o.sock", env, "win32"), "\\\\.\\pipe\\C:\\o.sock");
    assert.equal(resolvePipeName("", env, "win32"), "\\\\.\\pipe\\C:\\env\\h.sock");
    assert.equal(resolvePipeName(undefined, { APPDATA: env.APPDATA }, "win32"), "\\\\.\\pipe\\C:\\Users\\x\\AppData\\Roaming\\herdr\\herdr.sock");
    assert.equal(resolvePipeName("\\\\.\\pipe\\already", env, "win32"), "\\\\.\\pipe\\already");
    assert.throws(() => resolvePipeName(undefined, {}, "win32"), /Cannot resolve/);
  });

  for (const platform of ["linux", "darwin"] as const) {
    it(`uses a Unix socket path on ${platform}: setting, then env, then ~/.config/herdr/herdr.sock`, () => {
      const env = { HERDR_SOCKET_PATH: "/run/env.sock", HOME: "/home/u", APPDATA: "C:\\ignored" };
      assert.equal(resolvePipeName("/tmp/o.sock", env, platform), "/tmp/o.sock");
      assert.equal(resolvePipeName("  ", env, platform), "/run/env.sock");
      assert.equal(resolvePipeName(undefined, { HOME: "/home/u" }, platform), "/home/u/.config/herdr/herdr.sock");
      assert.throws(() => resolvePipeName(undefined, {}, platform), /herdrNavigator\.socketPath/);
    });
  }
});
