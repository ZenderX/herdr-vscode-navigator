import { posix, win32 } from "node:path";

export interface GitRootDeps {
  /** True when `<dir>/.git` exists as a file or directory (a file in worktrees and submodules). */
  hasGitEntry: (dir: string) => Promise<boolean>;
  platform: NodeJS.Platform;
}

/** Nearest ancestor of dir (dir included) holding a `.git` entry; dir itself outside a repository or on any error. */
export async function findGitRoot(dir: string, { hasGitEntry, platform }: GitRootDeps): Promise<string> {
  const { dirname } = platform === "win32" ? win32 : posix;
  try {
    let current = dir;
    for (;;) {
      if (await hasGitEntry(current)) return current;
      const parent = dirname(current);
      if (parent === current) return dir;
      current = parent;
    }
  } catch {
    return dir;
  }
}
