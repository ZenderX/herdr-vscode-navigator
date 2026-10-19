import assert from "node:assert/strict";
import { navigatorWorkspaceContent, planWorkspaceFile } from "../../../follow/planFolders";
import type { WorkspaceFileInput, WorkspaceFilePlan } from "../../../follow/planFolders";
import { workspaceFilePath } from "../../../vscode/anchorPath";

const ANCHOR = "C:\\storage\\anchor";
const TARGET = "C:\\work\\project-a";

const plan = (input: Partial<WorkspaceFileInput>): WorkspaceFilePlan =>
  planWorkspaceFile({ folders: [], workspaceFileScheme: undefined, anchorPath: ANCHOR, target: TARGET, platform: "win32", ...input });

describe("planWorkspaceFile", () => {
  it("writes [anchor, folder] for a single-folder window", () => {
    const result = plan({ folders: [{ path: "C:\\work\\other" }] });
    assert.equal(result.action, "write-file-and-open");
    if (result.action !== "write-file-and-open") return;
    assert.deepEqual(JSON.parse(result.content), { folders: [{ path: ANCHOR }, { path: TARGET }] });
  });

  it("writes the file for an empty window", () => {
    assert.equal(plan({ folders: [] }).action, "write-file-and-open");
  });

  it("recognises a saved navigator, ignoring drive-letter case", () => {
    const result = plan({
      folders: [{ path: "c:\\storage\\anchor" }, { path: TARGET }],
      workspaceFileScheme: "file",
    });
    assert.equal(result.action, "already-saved-navigator");
  });

  it("flags an untitled navigator as legacy", () => {
    const result = plan({ folders: [{ path: ANCHOR }, { path: TARGET }], workspaceFileScheme: "untitled" });
    assert.equal(result.action, "legacy-untitled");
  });

  it("leaves a user's own workspace alone", () => {
    assert.equal(plan({ folders: [{ path: "C:\\a" }, { path: "C:\\b" }], workspaceFileScheme: "file" }).action, "none");
    assert.equal(plan({ folders: [{ path: "C:\\a" }, { path: "C:\\b" }] }).action, "none");
  });

  it("rejects an empty anchor", () => {
    assert.throws(() => plan({ anchorPath: "" }));
  });
});

describe("navigatorWorkspaceContent", () => {
  it("lists the anchor once when the target is the anchor", () => {
    assert.deepEqual(JSON.parse(navigatorWorkspaceContent(ANCHOR, "c:\\STORAGE\\anchor", "win32")), { folders: [{ path: ANCHOR }] });
  });
});

describe("workspaceFilePath", () => {
  it("sits inside the anchor directory", () => {
    assert.match(workspaceFilePath(ANCHOR).replace(/\\/g, "/"), /\/anchor\/navigator\.code-workspace$/);
  });
});
