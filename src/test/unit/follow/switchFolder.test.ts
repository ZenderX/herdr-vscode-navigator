import assert from "node:assert/strict";
import { FollowController } from "../../../follow/controller";
import { planFollowAction } from "../../../follow/planFollow";
import { openFolderInWindow, switchFolder } from "../../../follow/switchFolder";
import type { FolderLike } from "../../../follow/planFolders";
import type { SessionSnapshot } from "../../../herdr";
import type { FollowMode } from "../../../follow/followMode";

const single: FolderLike[] = [{ path: "C:\\proj" }];
const multi: FolderLike[] = [{ path: "C:\\anchor" }, { path: "C:\\proj" }];

describe("planFollowAction", () => {
  const base = { platform: "win32" as const };

  it("is a no-op when the target is the current single folder, ignoring case and separators", () => {
    const action = planFollowAction({ ...base, mode: "folder", folders: single, isMultiRoot: false, target: "c:/PROJ" });
    assert.equal(action.kind, "noop");
  });

  it("opens a different target in folder mode", () => {
    assert.deepEqual(planFollowAction({ ...base, mode: "folder", folders: single, isMultiRoot: false, target: "C:\\other" }), {
      kind: "openFolder",
      target: "C:\\other",
    });
  });

  it("switches from a multi-root window even when the target is one of its roots", () => {
    assert.equal(planFollowAction({ ...base, mode: "folder", folders: multi, isMultiRoot: true, target: "C:\\proj" }).kind, "openFolder");
  });

  it("switches from an empty window", () => {
    assert.equal(planFollowAction({ ...base, mode: "folder", folders: [], isMultiRoot: false, target: "C:\\proj" }).kind, "openFolder");
  });

  it("never opens a folder in workspace mode", () => {
    for (const folders of [single, multi, []]) {
      for (const target of ["C:\\proj", "C:\\other"]) {
        assert.equal(planFollowAction({ ...base, mode: "workspace", folders, isMultiRoot: folders.length > 1, target }).kind, "workspace");
      }
    }
  });
});

describe("openFolderInWindow", () => {
  it("runs vscode.openFolder for the target uri with forceReuseWindow", async () => {
    const calls: unknown[][] = [];
    await openFolderInWindow(
      {
        executeCommand: async (...args) => {
          calls.push(args);
        },
        fileUri: (path) => `uri:${path}`,
      },
      "C:\\next",
    );
    assert.deepEqual(calls, [["vscode.openFolder", "uri:C:\\next", { forceReuseWindow: true }]]);
  });
});

describe("switchFolder", () => {
  const yes = { confirm: async () => true, isCurrent: () => true };

  it("persists the target before opening the folder", async () => {
    const order: string[] = [];
    const opened = await switchFolder(
      {
        ...yes,
        persistLastFollowed: async (target) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          order.push(`persist ${target}`);
        },
        openFolder: async (target) => {
          order.push(`open ${target}`);
        },
      },
      "C:\\next",
    );
    assert.equal(opened, true);
    assert.deepEqual(order, ["persist C:\\next", "open C:\\next"]);
  });

  it("does not open when the user declines the notice", async () => {
    const order: string[] = [];
    const opened = await switchFolder(
      {
        confirm: async () => false,
        isCurrent: () => true,
        persistLastFollowed: async () => void order.push("persist"),
        openFolder: async () => void order.push("open"),
      },
      "C:\\next",
    );
    assert.equal(opened, false);
    assert.deepEqual(order, []);
  });

  it("does not open when the decision went stale while the notice was pending", async () => {
    const order: string[] = [];
    const opened = await switchFolder(
      {
        confirm: async () => true,
        isCurrent: () => false,
        persistLastFollowed: async () => void order.push("persist"),
        openFolder: async () => void order.push("open"),
      },
      "C:\\next",
    );
    assert.equal(opened, false);
    assert.deepEqual(order, []);
  });

  it("does not open the folder when persisting fails", async () => {
    let opened = false;
    await assert.rejects(
      switchFolder(
        {
          ...yes,
          persistLastFollowed: async () => {
            throw new Error("disk full");
          },
          openFolder: async () => {
            opened = true;
          },
        },
        "C:\\next",
      ),
      /disk full/,
    );
    assert.equal(opened, false);
  });
});

function snap(cwd: string): SessionSnapshot {
  return {
    focused_workspace_id: "w",
    focused_tab_id: "tab",
    focused_pane_id: "p1",
    panes: [{ pane_id: "p1", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: true, cwd }],
    tabs: [],
    workspaces: [],
  };
}

function folderController(mode: FollowMode, folders: FolderLike[], isMulti: boolean, suppressFirstSwitch = false) {
  const switched: string[] = [];
  const applied: string[] = [];
  const cwd = { value: "C:\\next" };
  const controller = new FollowController({
    platform: "win32",
    mode,
    suppressFirstSwitch,
    fetchSnapshot: async () => snap(cwd.value),
    applyPlan: async (plan) => {
      applied.push(plan.kind);
      return true;
    },
    persistPendingTarget: async () => {},
    switchFolder: async (target) => {
      switched.push(target);
      return true;
    },
    getFolders: () => folders,
    isMultiRoot: () => isMulti,
    getAnchorPath: () => "C:\\anchor",
    autoFollow: true,
    debounceMs: 0,
    cwdSource: "auto",
  });
  return { controller, switched, applied, cwd };
}

describe("FollowController folder mode", () => {
  it("switches to a different target", async () => {
    const h = folderController("folder", single, false);
    await h.controller.followNow();
    assert.deepEqual(h.switched, ["C:\\next"]);
    assert.deepEqual(h.applied, []);
  });

  it("does nothing when the target is the current single folder", async () => {
    const h = folderController("folder", [{ path: "C:\\next" }], false);
    await h.controller.followNow();
    assert.deepEqual(h.switched, []);
    assert.deepEqual(h.applied, []);
  });

  it("switches a multi-root window", async () => {
    const h = folderController("folder", multi, true);
    await h.controller.followNow();
    assert.deepEqual(h.switched, ["C:\\next"]);
  });

  it("uses the workspace pipeline and never switches in workspace mode", async () => {
    const h = folderController("workspace", multi, true);
    await h.controller.followNow();
    assert.deepEqual(h.switched, []);
    assert.deepEqual(h.applied, ["append"]);
  });

  it("skips the first evaluation after its own reload, then follows normally", async () => {
    const h = folderController("folder", single, false, true);
    const focus = async (): Promise<void> => {
      h.controller.onFocusEvent();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await h.controller.whenIdle();
    };
    await focus();
    assert.deepEqual(h.switched, [], "first evaluation after own reload must not switch");
    h.cwd.value = "C:\\later";
    await focus();
    assert.deepEqual(h.switched, ["C:\\later"]);
  });

  it("never suppresses an explicit followNow after its own reload", async () => {
    const h = folderController("folder", single, false, true);
    await h.controller.followNow();
    assert.deepEqual(h.switched, ["C:\\next"]);
  });

  it("does not open the folder when the mode changes to workspace while the notice is pending", async () => {
    const opened: string[] = [];
    const confirmed: string[] = [];
    const controller: FollowController = new FollowController({
      platform: "win32",
      mode: "folder",
      fetchSnapshot: async () => snap("C:\\next"),
      applyPlan: async () => true,
      persistPendingTarget: async () => {},
      switchFolder: (target, isCurrent) =>
        switchFolder(
          {
            confirm: async () => {
              // The user flips the setting while the notice is displayed.
              confirmed.push(target);
              controller.setMode("workspace");
              return true;
            },
            isCurrent,
            persistLastFollowed: async () => {},
            openFolder: async (path) => void opened.push(path),
          },
          target,
        ),
      getFolders: () => single,
      isMultiRoot: () => false,
      getAnchorPath: () => "C:\\anchor",
      autoFollow: true,
      debounceMs: 0,
      cwdSource: "auto",
    });
    await controller.followNow();
    assert.deepEqual(confirmed, ["C:\\next"], "the notice must have been reached");
    assert.deepEqual(opened, []);
  });

  it("follows to a new mode set at runtime", async () => {
    const h = folderController("workspace", multi, true);
    h.controller.setMode("folder");
    await h.controller.followNow();
    assert.deepEqual(h.switched, ["C:\\next"]);
  });
});
