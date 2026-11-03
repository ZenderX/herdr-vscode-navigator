import assert from "node:assert/strict";
import { findGitRoot, worktreeParentName } from "../../../follow/gitRoot";

function entries(...dirs: string[]): (dir: string) => Promise<boolean> {
  return async (dir) => dirs.includes(dir);
}

describe("findGitRoot", () => {
  it("snaps to the nearest repository root, and leaves the directory unchanged outside a repository or when a check throws", async () => {
    assert.equal(await findGitRoot("C:\\Games\\repo\\src\\game", { hasGitEntry: entries("C:\\Games\\repo"), platform: "win32" }), "C:\\Games\\repo");
    const nested = { hasGitEntry: entries("/home/me/repo", "/home/me/repo/vendor/lib"), platform: "darwin" } as const;
    assert.equal(await findGitRoot("/home/me/repo/vendor/lib/src", nested), "/home/me/repo/vendor/lib");

    const seen: string[] = [];
    const outside = await findGitRoot("C:\\Users\\me\\scratch", { hasGitEntry: async (dir) => (seen.push(dir), false), platform: "win32" });
    assert.equal(outside, "C:\\Users\\me\\scratch");
    assert.deepEqual(seen, ["C:\\Users\\me\\scratch", "C:\\Users\\me", "C:\\Users", "C:\\"]);

    const throwing = async (dir: string): Promise<boolean> => {
      if (dir === "/home/me/repo") throw new Error("EACCES");
      return false;
    };
    assert.equal(await findGitRoot("/home/me/repo/src", { hasGitEntry: throwing, platform: "linux" }), "/home/me/repo/src");
  });
});

function files(contents: Record<string, string>): (path: string) => Promise<string | undefined> {
  return async (path) => contents[path];
}

describe("worktreeParentName", () => {
  it("names a linked worktree after its parent project in every layout, and leaves submodules and plain repositories unnamed", async () => {
    const mainCheckoutWin = files({
      "C:\\Users\\me\\worktrees\\develop\\.git": "gitdir: C:/Users/me/mainproj/.git/worktrees/develop\n",
      "C:\\Users\\me\\mainproj\\.git\\worktrees\\develop\\commondir": "../..\n",
    });
    assert.equal(await worktreeParentName("C:\\Users\\me\\worktrees\\develop", { readTextFile: mainCheckoutWin, platform: "win32" }), "mainproj");

    const relativeBareDirWin = files({
      "C:\\src\\mainproj\\develop\\.git": "gitdir: ../.bare/worktrees/develop\r\n",
      "C:\\src\\mainproj\\.bare\\worktrees\\develop\\commondir": "../..\r\n",
    });
    assert.equal(await worktreeParentName("C:\\src\\mainproj\\develop", { readTextFile: relativeBareDirWin, platform: "win32" }), "mainproj");

    const bareRepo = files({
      "/home/me/develop/.git": "gitdir: /srv/git/mainproj.git/worktrees/develop\n",
      "/srv/git/mainproj.git/worktrees/develop/commondir": "../..\n",
    });
    assert.equal(await worktreeParentName("/home/me/develop", { readTextFile: bareRepo, platform: "linux" }), "mainproj");

    const relativeMainCheckout = files({
      "/Users/me/mainproj/.worktrees/develop/.git": "gitdir: ../../.git/worktrees/develop\n",
      "/Users/me/mainproj/.git/worktrees/develop/commondir": "../..\n",
    });
    assert.equal(await worktreeParentName("/Users/me/mainproj/.worktrees/develop", { readTextFile: relativeMainCheckout, platform: "darwin" }), "mainproj");

    const submodule = files({ "/home/me/mainproj/vendor/lib/.git": "gitdir: ../../.git/modules/lib\n" });
    assert.equal(await worktreeParentName("/home/me/mainproj/vendor/lib", { readTextFile: submodule, platform: "linux" }), undefined);
    assert.equal(await worktreeParentName("C:\\Users\\me\\mainproj", { readTextFile: files({}), platform: "win32" }), undefined);
  });
});
