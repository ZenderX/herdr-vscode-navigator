import assert from "node:assert/strict";
import { planWorkspaceFile } from "../../../follow/planFolders";
import type { WorkspaceFileInput, WorkspaceFilePlan } from "../../../follow/planFolders";

const ANCHOR = "C:\\storage\\anchor";
const TARGET = "C:\\work\\project-a";

const plan = (input: Partial<WorkspaceFileInput>): WorkspaceFilePlan =>
  planWorkspaceFile({ folders: [], workspaceFileScheme: undefined, anchorPath: ANCHOR, target: TARGET, platform: "win32", ...input });

describe("planWorkspaceFile", () => {
  it("writes [anchor, target] for a plain window, recognises saved and untitled navigators, and leaves a user's own workspace alone", () => {
    const result = plan({ folders: [{ path: "C:\\work\\other" }] });
    assert.equal(result.action, "write-file-and-open");
    if (result.action !== "write-file-and-open") return;
    assert.deepEqual(JSON.parse(result.content), { folders: [{ path: ANCHOR }, { path: TARGET }] });
    assert.equal(plan({ folders: [{ path: "c:\\storage\\anchor" }, { path: TARGET }], workspaceFileScheme: "file" }).action, "already-saved-navigator");
    assert.equal(plan({ folders: [{ path: ANCHOR }, { path: TARGET }], workspaceFileScheme: "untitled" }).action, "legacy-untitled");
    assert.equal(plan({ folders: [{ path: "C:\\a" }, { path: "C:\\b" }], workspaceFileScheme: "file" }).action, "none");
  });
});
