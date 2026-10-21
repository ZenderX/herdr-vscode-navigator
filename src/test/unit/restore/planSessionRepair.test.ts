import assert from "node:assert/strict";
import type { RestoreManifest } from "../../../restore/manifest";
import { planSessionRepair } from "../../../restore/planSessionRepair";
import type { LoadedSessionFile, SessionData } from "../../../restore/sessionFile";

const SESSION_PATH = "C:\\Users\\me\\AppData\\Roaming\\herdr\\session.json";
const NOW = new Date("2026-01-10T00:00:00Z");
const SPAWN = "C:\\Users\\me\\proj\\";
const LIVE = "C:\\Users\\me\\other\\sub";
const FOLDER = "C:\\Users\\me\\other";

function sessionData(): SessionData {
  return {
    version: 3,
    active: 0,
    future_field: { keep: true },
    workspaces: [
      {
        id: "w1",
        identity_cwd: SPAWN,
        worktree_space: {
          key: "\\\\?\\C:\\Users\\me\\proj",
          repo_root: "\\\\?\\C:\\Users\\me\\proj",
          is_linked_worktree: false,
        },
        tabs: [
          {
            panes: {
              "1": { cwd: SPAWN, agent_session: { source: "s", agent: "a", kind: "k", value: "sess-a" } },
              "2": { cwd: SPAWN },
            },
          },
        ],
      },
    ],
  };
}

function file(session: SessionData = sessionData()): LoadedSessionFile {
  return { path: SESSION_PATH, session };
}

function manifest(overrides: Partial<RestoreManifest> = {}): RestoreManifest {
  return {
    manifestVersion: 1,
    sessionFilePath: SESSION_PATH,
    observedAt: "2026-01-09T00:00:00Z",
    workspaces: [
      {
        id: "w1",
        label: "other",
        folder: FOLDER,
        panes: [
          { internalId: "1", publicNumber: 1, spawnCwd: "C:\\USERS\\me\\proj", agentSessionId: "sess-a", liveCwd: LIVE, observedAt: "2026-01-09T00:00:00Z" },
          { internalId: "2", publicNumber: 2, spawnCwd: SPAWN, liveCwd: "C:\\Users\\me\\other\\two", observedAt: "2026-01-09T00:00:00Z" },
        ],
      },
    ],
    ...overrides,
  };
}

function plan(m: RestoreManifest, f: LoadedSessionFile = file()) {
  return planSessionRepair(f, m, "win32", NOW);
}

describe("planSessionRepair", () => {
  it("rewrites pane cwd and identity_cwd, mirroring the trailing separator", () => {
    const result = plan(manifest());
    assert.equal(result.kind, "rewrite");
    if (result.kind !== "rewrite") return;
    const ws = result.session.workspaces[0];
    assert.ok(ws);
    assert.equal(ws.identity_cwd, "C:\\Users\\me\\other\\");
    assert.equal(ws.tabs[0]?.panes["1"]?.cwd, "C:\\Users\\me\\other\\sub\\");
    assert.equal(ws.tabs[0]?.panes["2"]?.cwd, "C:\\Users\\me\\other\\two\\");
    assert.equal(result.session["future_field"] !== undefined, true);
    assert.equal(result.changes.length, 3);
    assert.deepEqual(result.changes[0], { workspaceId: "w1", paneId: "1", from: SPAWN, to: "C:\\Users\\me\\other\\sub\\" });
  });

  it("does not mutate the input file", () => {
    const input = file();
    const before = JSON.stringify(input.session);
    plan(manifest(), input);
    assert.equal(JSON.stringify(input.session), before);
  });

  it("mirrors forward slashes and a missing trailing separator", () => {
    const session = sessionData();
    const pane = session.workspaces[0]?.tabs[0]?.panes["2"];
    assert.ok(pane);
    pane.cwd = "C:/Users/me/proj";
    const result = plan(manifest(), file(session));
    assert.equal(result.kind, "rewrite");
    if (result.kind !== "rewrite") return;
    assert.equal(result.session.workspaces[0]?.tabs[0]?.panes["2"]?.cwd, "C:/Users/me/other/two");
  });

  it("leaves a pane whose spawnCwd differs untouched while repairing its sibling", () => {
    const m = manifest();
    const second = m.workspaces[0]?.panes[1];
    assert.ok(second);
    second.spawnCwd = "C:\\Users\\me\\elsewhere";
    const result = plan(m);
    assert.equal(result.kind, "rewrite");
    if (result.kind !== "rewrite") return;
    assert.equal(result.session.workspaces[0]?.tabs[0]?.panes["2"]?.cwd, SPAWN);
    assert.equal(result.session.workspaces[0]?.tabs[0]?.panes["1"]?.cwd, "C:\\Users\\me\\other\\sub\\");
  });

  it("leaves a pane alone when the agent session ids disagree", () => {
    const m = manifest();
    const first = m.workspaces[0]?.panes[0];
    assert.ok(first);
    first.agentSessionId = "sess-other";
    const result = plan(m);
    assert.equal(result.kind, "rewrite");
    if (result.kind !== "rewrite") return;
    assert.equal(result.session.workspaces[0]?.tabs[0]?.panes["1"]?.cwd, SPAWN);
    assert.equal(result.session.workspaces[0]?.tabs[0]?.panes["2"]?.cwd, "C:\\Users\\me\\other\\two\\");
  });

  it("leaves with distinct reasons for no workspace, stale manifest and path mismatch", () => {
    const noWorkspace = manifest();
    const first = noWorkspace.workspaces[0];
    assert.ok(first);
    first.id = "w9";
    const reasons = [
      plan(noWorkspace),
      plan(manifest({ observedAt: "2025-12-01T00:00:00Z" })),
      plan(manifest({ sessionFilePath: "C:\\Users\\me\\x\\session.json" })),
    ].map((result) => (result.kind === "leave" ? result.reason : "rewrite"));
    assert.deepEqual(reasons, ["no-matching-workspace", "stale-manifest", "path-mismatch"]);
  });

  it("leaves when every matched value is already current", () => {
    const first = manifest();
    const rewritten = plan(first);
    assert.equal(rewritten.kind, "rewrite");
    if (rewritten.kind !== "rewrite") return;
    const again = manifest();
    for (const pane of again.workspaces[0]?.panes ?? []) pane.spawnCwd = pane.liveCwd;
    assert.deepEqual(plan(again, file(rewritten.session)), { kind: "leave", reason: "nothing-to-change" });
  });

  // herdr does not re-derive an omitted worktree_space and a linked worktree lives outside its repo root, so it is never dropped.
  it("keeps worktree_space even when its repo_root does not contain the new identity_cwd", () => {
    const original = sessionData().workspaces[0]?.worktree_space;
    const result = plan(manifest());
    assert.equal(result.kind, "rewrite");
    if (result.kind !== "rewrite") return;
    assert.deepEqual(result.session.workspaces[0]?.worktree_space, original);
    assert.equal(result.changes.length, 3);
  });

  it("is case-sensitive on linux", () => {
    const session = sessionData();
    const ws = session.workspaces[0];
    assert.ok(ws);
    ws.identity_cwd = "/home/me/proj";
    for (const pane of Object.values(ws.tabs[0]?.panes ?? {})) pane.cwd = "/home/me/proj";
    delete ws.worktree_space;
    const m = manifest({ sessionFilePath: "/c/herdr/session.json" });
    const mw = m.workspaces[0];
    assert.ok(mw);
    mw.folder = "/home/me/other";
    mw.panes = [{ internalId: "2", publicNumber: 2, spawnCwd: "/home/me/PROJ", liveCwd: "/home/me/other", observedAt: m.observedAt }];
    const result = planSessionRepair({ path: "/c/herdr/session.json", session }, m, "linux", NOW);
    assert.deepEqual(result, { kind: "leave", reason: "no-matching-workspace" });
  });
});
