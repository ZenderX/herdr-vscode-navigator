import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareNavigatorWorkspaceFile } from "../../../vscode/navigatorFile";

// The temp paths follow the real OS, so the platform must too when the suite runs with a spoofed process.platform.
const PLATFORM: NodeJS.Platform = path.sep === "\\" ? "win32" : "linux";
const ANCHOR = path.join(os.tmpdir(), "herdr-anchor");
const TARGET = path.join(os.tmpdir(), "herdr-target");

describe("prepareNavigatorWorkspaceFile", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-nav-"));
    file = path.join(dir, "navigator.code-workspace");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates the file with [anchor, target] when none exists", async () => {
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { folders: [{ path: ANCHOR }, { path: TARGET }] });
  });

  it("leaves an existing navigator file byte-for-byte alone so a window that has it open keeps its folders", async () => {
    const text = JSON.stringify({
      folders: [{ path: ANCHOR }, { path: "/someone/elses" }],
      settings: { "window.title": "x", "editor.tabSize": 2 },
    });
    await fs.writeFile(file, text, "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "kept");
    assert.equal(await fs.readFile(file, "utf8"), text);
  });

  it("keeps every other key and setting when it must replace folders that lack the anchor", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ folders: [{ path: "/other" }], settings: { "window.title": "x", "editor.tabSize": 2 }, extensions: { recommendations: ["a.b"] } }),
      "utf8",
    );
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
      folders: [{ path: ANCHOR }, { path: TARGET }],
      settings: { "window.title": "x", "editor.tabSize": 2 },
      extensions: { recommendations: ["a.b"] },
    });
  });

  it("replaces an unparsable file with a fresh one", async () => {
    await fs.writeFile(file, "{ not json", "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { folders: [{ path: ANCHOR }, { path: TARGET }] });
  });
});
