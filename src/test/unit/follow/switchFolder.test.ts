import assert from "node:assert/strict";
import { FollowController } from "../../../follow/controller";
import { planFollowAction } from "../../../follow/planFollow";
import { switchFolder } from "../../../follow/switchFolder";
import type { FolderLike } from "../../../follow/planFolders";
import type { SessionSnapshot } from "../../../herdr";
import type { FollowMode } from "../../../follow/followMode";

const single: FolderLike[] = [{ path: "C:\\proj" }];
const multi: FolderLike[] = [{ path: "C:\\anchor" }, { path: "C:\\proj" }];

describe("planFollowAction", () => {
  const base = { platform: "win32" as const };

  it("opens a different folder in folder mode, does nothing for the current one, and never opens one in workspace mode", () => {
    assert.equal(planFollowAction({ ...base, mode: "folder", folders: single, isMultiRoot: false, target: "c:/PROJ" }).kind, "noop");
    assert.deepEqual(planFollowAction({ ...base, mode: "folder", folders: single, isMultiRoot: false, target: "C:\\other" }), {
      kind: "openFolder",
      target: "C:\\other",
    });
    assert.equal(planFollowAction({ ...base, mode: "folder", folders: multi, isMultiRoot: true, target: "C:\\proj" }).kind, "openFolder");
    for (const folders of [single, multi, []]) {
      assert.equal(planFollowAction({ ...base, mode: "workspace", folders, isMultiRoot: folders.length > 1, target: "C:\\other" }).kind, "workspace");
    }
  });
});

describe("switchFolder", () => {
  it("persists the target before opening it, and opens nothing when the user declines or the decision went stale", async () => {
    const run = async (confirmed: boolean, current: boolean) => {
      const order: string[] = [];
      const opened = await switchFolder(
        {
          confirm: async () => confirmed,
          isCurrent: () => current,
          persistLastFollowed: async (target) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push(`persist ${target}`);
          },
          openFolder: async (target) => void order.push(`open ${target}`),
        },
        "C:\\next",
      );
      return { opened, order };
    };
    assert.deepEqual(await run(true, true), { opened: true, order: ["persist C:\\next", "open C:\\next"] });
    assert.deepEqual(await run(false, true), { opened: false, order: [] });
    assert.deepEqual(await run(true, false), { opened: false, order: [] });
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
  it("switches to the focused pane's folder, but skips the first evaluation after its own reload", async () => {
    const plain = folderController("folder", single, false);
    await plain.controller.followNow();
    assert.deepEqual(plain.switched, ["C:\\next"]);
    assert.deepEqual(plain.applied, []);

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
});
