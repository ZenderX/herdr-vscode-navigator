import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NAVIGATOR_GIT_SETTINGS, navigatorWorkspaceContent, planWorkspaceFile } from "../../../follow/planFolders";
import type { WorkspaceFileInput, WorkspaceFilePlan } from "../../../follow/planFolders";
import { prepareNavigatorWorkspaceFile } from "../../../vscode/navigatorFile";

const ANCHOR = "C:\\storage\\anchor";
const TARGET = "C:\\work\\project-a";

// The temp paths follow the real OS, so the platform must too when the suite runs with a spoofed process.platform.
const FS_PLATFORM: NodeJS.Platform = path.sep === "\\" ? "win32" : "linux";
const FS_ANCHOR = path.join(os.tmpdir(), "herdr-anchor");
const FS_TARGET = path.join(os.tmpdir(), "herdr-target");

const plan = (input: Partial<WorkspaceFileInput>): WorkspaceFilePlan =>
  planWorkspaceFile({ folders: [], workspaceFileScheme: undefined, anchorPath: ANCHOR, target: TARGET, platform: "win32", ...input });

describe("planWorkspaceFile", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-nav-"));
    file = path.join(dir, "navigator.code-workspace");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes [anchor, target] with the Git settings that stop a second repository, recognises saved and untitled navigators, leaves a user's own workspace alone, keeps an existing navigator file byte-for-byte, and on a rewrite never drops or overrides what a file already has", async () => {
    const result = plan({ folders: [{ path: "C:\\work\\other" }] });
    assert.equal(result.action, "write-file-and-open");
    if (result.action !== "write-file-and-open") return;
    assert.deepEqual(JSON.parse(result.content), { folders: [{ path: ANCHOR }, { path: TARGET }], settings: NAVIGATOR_GIT_SETTINGS });
    assert.equal(plan({ folders: [{ path: "c:\\storage\\anchor" }, { path: TARGET }], workspaceFileScheme: "file" }).action, "already-saved-navigator");
    assert.equal(plan({ folders: [{ path: ANCHOR }, { path: TARGET }], workspaceFileScheme: "untitled" }).action, "legacy-untitled");
    assert.equal(plan({ folders: [{ path: "C:\\a" }, { path: "C:\\b" }], workspaceFileScheme: "file" }).action, "none");

    // Pinned literally: these values are what keeps Source Control to one repository, so a change here must fail.
    assert.deepEqual(NAVIGATOR_GIT_SETTINGS, {
      "git.autoRepositoryDetection": false,
      "git.detectSubmodules": false,
      "git.detectWorktrees": false,
      "git.openRepositoryInParentFolders": "always",
    });

    assert.equal(await prepareNavigatorWorkspaceFile(file, FS_ANCHOR, FS_TARGET, FS_PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { folders: [{ path: FS_ANCHOR }, { path: FS_TARGET }], settings: NAVIGATOR_GIT_SETTINGS });

    // A window that has the file open must keep its folders.
    const kept = JSON.stringify({ folders: [{ path: FS_ANCHOR }, { path: "/someone/elses" }], settings: { "window.title": "x" } });
    await fs.writeFile(file, kept, "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, FS_ANCHOR, FS_TARGET, FS_PLATFORM), "kept");
    assert.equal(await fs.readFile(file, "utf8"), kept);

    await fs.writeFile(file, JSON.stringify({ folders: [{ path: "/other" }], settings: { "editor.tabSize": 2 } }), "utf8");
    assert.equal(await prepareNavigatorWorkspaceFile(file, FS_ANCHOR, FS_TARGET, FS_PLATFORM), "written");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
      folders: [{ path: FS_ANCHOR }, { path: FS_TARGET }],
      settings: { ...NAVIGATOR_GIT_SETTINGS, "editor.tabSize": 2 },
    });

    const existing = JSON.stringify({ folders: [], extensions: { recommendations: ["a.b"] }, settings: { "git.detectSubmodules": true, "window.title": "x" } });
    assert.deepEqual(JSON.parse(navigatorWorkspaceContent(ANCHOR, TARGET, "win32", existing)), {
      folders: [{ path: ANCHOR }, { path: TARGET }],
      extensions: { recommendations: ["a.b"] },
      settings: { ...NAVIGATOR_GIT_SETTINGS, "git.detectSubmodules": true, "window.title": "x" },
    });
    assert.deepEqual(JSON.parse(navigatorWorkspaceContent(ANCHOR, TARGET, "win32", JSON.stringify({ settings: 5 }))).settings, NAVIGATOR_GIT_SETTINGS);
  });
});
