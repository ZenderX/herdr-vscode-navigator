import { isSameOrInside, normalizeCwd, samePath } from "../paths";

const BURST_LIMIT = 3;
const BURST_WINDOW_MS = 10_000;

export interface ScmDecisionInput {
  /** `[anchor, followed]`, the followed folder at index 1. */
  folders: readonly string[];
  /** Open repository roots as `fsPath`. */
  roots: readonly string[];
  /** A root opened ahead of its folder swap: it is about to be the owned one, so it is no stray. */
  incoming?: string;
  platform: NodeJS.Platform;
}

export interface ScmDecision {
  /** The root as Git spelled it, or null when no open root serves the followed folder. */
  owned: string | null;
  strays: string[];
}

export interface ToggleAttempt {
  root: string;
  /** Milliseconds, on the clock injected as `now`. */
  at: number;
}

export type ScmHoldReason = "survived-false-write" | "burst";

export interface ScmHold {
  root: string;
  reason: ScmHoldReason;
}

export interface LoopGuardInput {
  strays: readonly string[];
  /** Every toggle attempt since the last folder change: clearing it is what releases a survivor, so age must not prune it. */
  history: readonly ToggleAttempt[];
  /** Strays still listed after the last false write. */
  survived: readonly string[];
  now: () => number;
  platform: NodeJS.Platform;
}

export interface LoopGuardDecision {
  toggle: string[];
  hold: ScmHold[];
}

/** What a read of a folder's `.git` entry found. */
export interface GitDirLook {
  isDirectory: boolean;
  hasHead: boolean;
  /** Any entry under `refs/heads`. */
  hasHeadRef: boolean;
  hasPackedRefs: boolean;
  hasIndex: boolean;
}

export interface AnchorGitInput {
  look: GitDirLook;
  /** Whether the followed folder holds a `.git` entry; absent with no followed folder to hand the pick on to. */
  followedHasGit?: boolean;
}

export type AnchorGitAction = "leave" | "remove" | "remove-and-init" | "remove-and-open";

/** The anchor holds no user content, so a `.git` that has never held a commit or staged a file is only a misplaced Initialize pick; anything more is left alone. */
export function decideAnchorGit({ look, followedHasGit }: AnchorGitInput): AnchorGitAction {
  const fresh = look.isDirectory && look.hasHead && !look.hasHeadRef && !look.hasPackedRefs && !look.hasIndex;
  if (!fresh) return "leave";
  if (followedHasGit === undefined) return "remove";
  return followedHasGit ? "remove-and-open" : "remove-and-init";
}

/** The branch Git's own `git.init` command would pass, cleaned as it cleans it, since `git init -b` refuses a raw name such as `my branch`. Empty leaves the choice to `git init`. */
export function initialBranch(defaultBranchName: unknown, branchWhitespaceChar: unknown): string {
  if (typeof defaultBranchName !== "string" || defaultBranchName === "") return "";
  const replacement = typeof branchWhitespaceChar === "string" ? branchWhitespaceChar : "-";
  return defaultBranchName
    .trim()
    .replace(/^-+/, "")
    .replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$|\[|\]$/g, replacement);
}

/**
 * Git's own rule for a folder's repository: the longest open root that equals or contains it is
 * owned, and every other root is a stray, whether nested, a parent, a main checkout or the anchor.
 */
export function decideScm({ folders, roots, incoming, platform }: ScmDecisionInput): ScmDecision {
  const followed = folders[1];
  const depth = (root: string): number => normalizeCwd(root, platform)?.length ?? 0;
  let owned: string | null = null;
  for (const root of roots) {
    if (!isSameOrInside(followed, root, platform)) continue;
    if (owned === null || depth(root) > depth(owned)) owned = root;
  }
  return { owned, strays: roots.filter((root) => root !== owned && !samePath(root, incoming, platform)) };
}

/**
 * Stops only a toggle that cannot work: a root that outlived the false write is never disposed,
 * as its own folder sets `git.enabled: true`, and a root back too often is Git undoing the toggle.
 */
export function guardToggles({ strays, history, survived, now, platform }: LoopGuardInput): LoopGuardDecision {
  const current = now();
  const toggle: string[] = [];
  const hold: ScmHold[] = [];
  for (const root of strays) {
    const attempts = history.filter((attempt) => samePath(attempt.root, root, platform));
    if (attempts.length > 0 && survived.some((survivor) => samePath(survivor, root, platform))) {
      hold.push({ root, reason: "survived-false-write" });
      continue;
    }
    if (attempts.filter(({ at }) => current - at < BURST_WINDOW_MS).length > BURST_LIMIT) {
      hold.push({ root, reason: "burst" });
      continue;
    }
    toggle.push(root);
  }
  return { toggle, hold };
}
