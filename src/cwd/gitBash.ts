import { win32 } from "node:path";
import type { ProbeDeps } from "./types";

type GitBashDeps = Pick<ProbeDeps, "env" | "exists">;

function fromPathEntries({ env, exists }: GitBashDeps): string[] {
  const dirs = (env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean);
  // git.exe lives in Git\cmd, Git\bin or Git\mingw64\bin; usr\bin sits beside the first two levels up.
  return dirs
    .filter((dir) => exists(win32.join(dir, "git.exe")))
    .flatMap((dir) => [win32.join(dir, "..", "usr", "bin", "bash.exe"), win32.join(dir, "..", "..", "usr", "bin", "bash.exe")]);
}

function fromWellKnownDirs({ env }: GitBashDeps): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter((root): root is string => Boolean(root));
  const candidates = roots.map((root) => win32.join(root, "Git", "usr", "bin", "bash.exe"));
  if (env.LocalAppData) candidates.push(win32.join(env.LocalAppData, "Programs", "Git", "usr", "bin", "bash.exe"));
  return candidates;
}

/** Locates Git for Windows' usr\bin\bash.exe: configured path, then git.exe on PATH, then well-known install dirs. */
export function findGitBash(configured: string, deps: GitBashDeps): string | undefined {
  const candidates = [...(configured ? [configured] : []), ...fromPathEntries(deps), ...fromWellKnownDirs(deps)];
  return candidates.map((candidate) => win32.normalize(candidate)).find((candidate) => deps.exists(candidate));
}
