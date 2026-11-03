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

export interface WorktreeNameDeps {
  /** Contents of the file at path; undefined when it is missing or a directory. */
  readTextFile: (path: string) => Promise<string | undefined>;
  platform: NodeJS.Platform;
}

/** Parent project name when dir is a linked-worktree root (its `.git` file's gitdir holds a `commondir`); undefined otherwise. */
export async function worktreeParentName(dir: string, { readTextFile, platform }: WorktreeNameDeps): Promise<string | undefined> {
  const { basename, dirname, join, resolve } = platform === "win32" ? win32 : posix;
  const gitdir = (await readTextFile(join(dir, ".git")))?.match(/^gitdir: *(.+?)\s*$/m)?.[1];
  if (!gitdir) return undefined;
  const resolvedGitdir = resolve(dir, gitdir);
  const commondir = (await readTextFile(join(resolvedGitdir, "commondir")))?.trim();
  if (!commondir) return undefined;

  const commonDir = resolve(resolvedGitdir, commondir);
  const name = basename(commonDir);
  // `.git` / `.bare` sit inside the project folder; a bare `mainproj.git` is the project itself.
  if (name.startsWith(".")) return basename(dirname(commonDir)) || undefined;
  return name.endsWith(".git") ? name.slice(0, -".git".length) : name;
}
