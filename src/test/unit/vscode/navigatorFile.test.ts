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

  it("creates [anchor, target], keeps an existing navigator file byte-for-byte, and replaces folders lacking the anchor without losing settings", async () => {
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { folders: [{ path: ANCHOR }, { path: TARGET }] });

    // A window that has the file open must keep its folders.
    const kept = JSON.stringify({ folders: [{ path: ANCHOR }, { path: "/someone/elses" }], settings: { "window.title": "x" } });
    await fs.writeFile(file, kept, "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "kept");
    assert.equal(await fs.readFile(file, "utf8"), kept);

    await fs.writeFile(file, JSON.stringify({ folders: [{ path: "/other" }], settings: { "editor.tabSize": 2 } }), "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, ANCHOR, TARGET, PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { folders: [{ path: ANCHOR }, { path: TARGET }], settings: { "editor.tabSize": 2 } });
  });
});
