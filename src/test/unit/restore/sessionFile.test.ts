import assert from "node:assert/strict";
import { parseSessionFile, resolveSessionFilePath, validateSession } from "../../../restore/sessionFile";
import type { PathEnv } from "../../../restore/sessionFile";

function env(vars: Record<string, string>, home = "/home/me"): PathEnv {
  return { get: (name) => vars[name], homeDir: () => home };
}

function minimalSession(): Record<string, unknown> {
  return {
    version: 3,
    workspaces: [
      {
        id: "w1",
        identity_cwd: "C:\\Users\\me\\proj\\",
        tabs: [{ panes: { "1": { cwd: "C:\\Users\\me\\proj\\" } } }],
      },
    ],
  };
}

describe("validateSession", () => {
  it("accepts a version 3 file", () => {
    assert.equal(validateSession(minimalSession()).ok, true);
  });

  it("rejects any other version", () => {
    for (const version of [2, 4, "3", undefined]) {
      const result = validateSession({ ...minimalSession(), version });
      assert.equal(result.ok, false);
    }
  });

  it("rejects mismatched workspace, tab and pane shapes", () => {
    const badWorkspaces = { ...minimalSession(), workspaces: {} };
    const badTabs = { ...minimalSession(), workspaces: [{ id: "w1", identity_cwd: "/p", tabs: {} }] };
    const badPanes = { ...minimalSession(), workspaces: [{ id: "w1", identity_cwd: "/p", tabs: [{ panes: [] }] }] };
    const badCwd = { ...minimalSession(), workspaces: [{ id: "w1", identity_cwd: "/p", tabs: [{ panes: { "1": { cwd: 4 } } }] }] };
    for (const candidate of [badWorkspaces, badTabs, badPanes, badCwd, null, []]) {
      assert.equal(validateSession(candidate).ok, false);
    }
  });

  it("preserves unknown fields through a parse and serialise round trip", () => {
    const original = minimalSession();
    original["future_top"] = { a: [1, 2] };
    const workspaces = original["workspaces"] as Record<string, unknown>[];
    const first = workspaces[0];
    assert.ok(first);
    first["future_ws"] = "kept";
    const result = parseSessionFile(JSON.stringify(original));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(JSON.parse(JSON.stringify(result.session)), original);
  });

  it("reports invalid JSON as a failure", () => {
    assert.equal(parseSessionFile("{nope").ok, false);
  });
});

describe("resolveSessionFilePath", () => {
  it("uses APPDATA on win32", () => {
    assert.deepEqual(resolveSessionFilePath("win32", env({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" })), {
      kind: "path",
      path: "C:\\Users\\me\\AppData\\Roaming\\herdr\\session.json",
    });
  });

  it("is unsupported on win32 without APPDATA", () => {
    assert.equal(resolveSessionFilePath("win32", env({})).kind, "unsupported");
  });

  it("uses ~/.config on linux and darwin", () => {
    for (const platform of ["linux", "darwin"] as const) {
      assert.deepEqual(resolveSessionFilePath(platform, env({})), { kind: "path", path: "/home/me/.config/herdr/session.json" });
    }
  });

  it("honours XDG_CONFIG_HOME", () => {
    assert.deepEqual(resolveSessionFilePath("linux", env({ XDG_CONFIG_HOME: "/xdg" })), {
      kind: "path",
      path: "/xdg/herdr/session.json",
    });
  });

  it("reports unsupported layout when HERDR_SESSION or HERDR_CONFIG_PATH is set", () => {
    for (const name of ["HERDR_SESSION", "HERDR_CONFIG_PATH"]) {
      for (const platform of ["win32", "linux", "darwin"] as const) {
        assert.equal(resolveSessionFilePath(platform, env({ [name]: "x", APPDATA: "C:\\a" })).kind, "unsupported");
      }
    }
  });
});
