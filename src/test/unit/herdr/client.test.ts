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
    it("round-trips a request by id and rejects an error response", async () => {
      server = await startServer((req, socket) =>
        req.method === "ping"
          ? reply(socket, req.id, { type: "pong", version: "0.9.5", protocol: 22 })
          : socket.write(`${JSON.stringify({ id: req.id, error: { code: "bad", message: "nope" } })}\n`),
      );
      const client = new HerdrClient({ pipeName: server.pipeName });
      const result = (await client.request("ping", {})) as { protocol: number };
      assert.equal(result.protocol, 22);
      await assert.rejects(client.request("session.snapshot", {}), /bad: nope/);
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

    it("focusWorkspace sends workspace.focus with workspace_id", async () => {
      server = await startServer((req, socket) => reply(socket, req.id, { type: "workspace_info", workspace: { workspace_id: "w4" } }));
      await new HerdrClient({ pipeName: server.pipeName }).focusWorkspace("w4");
      assert.equal(server.requests[0].method, "workspace.focus");
      assert.deepEqual(server.requests[0].params, { workspace_id: "w4" });
    });

    it("rejects state-changing methods outside the read-only allowlist without connecting", async () => {
      server = await startServer(() => undefined);
      for (const method of ["pane.close", "pane.send_text", "workspace.create", "server.stop"]) {
        await assert.rejects(new HerdrClient({ pipeName: server.pipeName }).request(method), /not allowed/, method);
      }
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

  it("matches the exact label first, then case-insensitively, and resolves duplicates only by the remembered folder", () => {
    assert.equal(findWorkspaceIdByLabel(snapshot([{ workspace_id: "w1", label: "alpha" }, { workspace_id: "w2", label: "Alpha" }]), "Alpha"), "w2");
    assert.equal(findWorkspaceIdByLabel(snapshot([{ workspace_id: "w3", label: "Docs" }]), "docs"), "w3");
    assert.equal(findWorkspaceIdByLabel(snapshot([{ workspace_id: "w1", label: "a" }]), "b"), undefined);
    const dupes = snapshot(
      [{ workspace_id: "w1", label: "x" }, { workspace_id: "w2", label: "x" }],
      [pane("w1", "C:\\a"), pane("w2", "C:\\b")],
    );
    assert.equal(findWorkspaceIdByLabel(dupes, "x", "C:\\b"), "w2");
    assert.equal(findWorkspaceIdByLabel(dupes, "x"), undefined);
    assert.equal(findWorkspaceIdByLabel(dupes, "x", "C:\\c"), undefined);
  });
});

describe("resolvePipeName", () => {
  it("prefers the setting, then HERDR_SOCKET_PATH, then herdr's default socket, as a named pipe on win32 and a Unix socket elsewhere", () => {
    const env = { HERDR_SOCKET_PATH: "C:\\env\\h.sock", APPDATA: "C:\\Users\\x\\AppData\\Roaming" };
    assert.equal(resolvePipeName("C:\\o.sock", env, "win32"), "\\\\.\\pipe\\C:\\o.sock");
    assert.equal(resolvePipeName("", env, "win32"), "\\\\.\\pipe\\C:\\env\\h.sock");
    assert.equal(resolvePipeName(undefined, { APPDATA: env.APPDATA }, "win32"), "\\\\.\\pipe\\C:\\Users\\x\\AppData\\Roaming\\herdr\\herdr.sock");
    assert.equal(resolvePipeName("\\\\.\\pipe\\already", env, "win32"), "\\\\.\\pipe\\already");
    for (const platform of ["linux", "darwin"] as const) {
      assert.equal(resolvePipeName("  ", { HERDR_SOCKET_PATH: "/run/env.sock", HOME: "/home/u" }, platform), "/run/env.sock");
      assert.equal(resolvePipeName(undefined, { HOME: "/home/u" }, platform), "/home/u/.config/herdr/herdr.sock");
      assert.throws(() => resolvePipeName(undefined, {}, platform), /herdrNavigator\.socketPath/);
    }
  });
});
