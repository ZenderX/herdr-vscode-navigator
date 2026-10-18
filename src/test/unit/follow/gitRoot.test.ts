import assert from "node:assert/strict";
import { findGitRoot } from "../../../follow/gitRoot";

function entries(...dirs: string[]): (dir: string) => Promise<boolean> {
  return async (dir) => dirs.includes(dir);
}

describe("findGitRoot", () => {
  it("snaps a nested directory to the repository root", async () => {
    const root = await findGitRoot("C:\\Games\\repo\\src\\game", { hasGitEntry: entries("C:\\Games\\repo"), platform: "win32" });
    assert.equal(root, "C:\\Games\\repo");
  });

  it("returns the directory itself when it is the root", async () => {
    const root = await findGitRoot("/home/me/repo", { hasGitEntry: entries("/home/me/repo"), platform: "linux" });
    assert.equal(root, "/home/me/repo");
  });

  it("picks the nearest root for nested repositories (submodule or worktree .git file)", async () => {
    const root = await findGitRoot("/home/me/repo/vendor/lib/src", {
      hasGitEntry: entries("/home/me/repo", "/home/me/repo/vendor/lib"),
      platform: "darwin",
    });
    assert.equal(root, "/home/me/repo/vendor/lib");
  });

  it("returns the directory unchanged outside a repository, ending at the win32 drive root", async () => {
    const seen: string[] = [];
    const root = await findGitRoot("C:\\Users\\me\\scratch", {
      hasGitEntry: async (dir) => {
        seen.push(dir);
        return false;
      },
      platform: "win32",
    });
    assert.equal(root, "C:\\Users\\me\\scratch");
    assert.deepEqual(seen, ["C:\\Users\\me\\scratch", "C:\\Users\\me", "C:\\Users", "C:\\"]);
  });

  it("returns the directory unchanged outside a repository, ending at the posix root", async () => {
    const seen: string[] = [];
    const root = await findGitRoot("/tmp/scratch", {
      hasGitEntry: async (dir) => {
        seen.push(dir);
        return false;
      },
      platform: "linux",
    });
    assert.equal(root, "/tmp/scratch");
    assert.deepEqual(seen, ["/tmp/scratch", "/tmp", "/"]);
  });

  it("finds a repository at the filesystem root", async () => {
    assert.equal(await findGitRoot("D:\\a\\b", { hasGitEntry: entries("D:\\"), platform: "win32" }), "D:\\");
    assert.equal(await findGitRoot("/a/b", { hasGitEntry: entries("/"), platform: "linux" }), "/");
  });

  it("returns the directory unchanged when a check throws", async () => {
    const root = await findGitRoot("/home/me/repo/src", {
      hasGitEntry: async (dir) => {
        if (dir === "/home/me/repo") throw new Error("EACCES");
        return false;
      },
      platform: "linux",
    });
    assert.equal(root, "/home/me/repo/src");
  });
});
