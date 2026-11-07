import { isSameOrInside, normalizeCwd, samePath } from "../paths";

const BURST_LIMIT = 3;
const BURST_WINDOW_MS = 10_000;

export interface ScmDecisionInput {
  /** `[anchor, followed]`, the followed folder at index 1. */
  folders: readonly string[];
  /** Open repository roots as `fsPath`. */
  roots: readonly string[];
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

/**
 * Git's own rule for a folder's repository: the longest open root that equals or contains it is
 * owned, and every other root is a stray, whether nested, a parent, a main checkout or the anchor.
 */
export function decideScm({ folders, roots, platform }: ScmDecisionInput): ScmDecision {
  const followed = folders[1];
  const depth = (root: string): number => normalizeCwd(root, platform)?.length ?? 0;
  let owned: string | null = null;
  for (const root of roots) {
    if (!isSameOrInside(followed, root, platform)) continue;
    if (owned === null || depth(root) > depth(owned)) owned = root;
  }
  return { owned, strays: roots.filter((root) => root !== owned) };
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

/** The offer targets a followed folder, so an anchor-only window has nothing to initialize. */
export function initOffer(folders: readonly string[], hasGitApi: boolean): boolean {
  return hasGitApi && folders.length >= 2;
}
