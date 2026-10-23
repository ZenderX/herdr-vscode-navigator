import assert from "node:assert/strict";
import { findGitRoot } from "../../../follow/gitRoot";

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
