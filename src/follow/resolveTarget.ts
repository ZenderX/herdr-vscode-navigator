import type { PaneInfo, SessionSnapshot } from "../herdr";
import type { CwdSource as LiveSource, FailedAttempt, ResolvedCwd } from "../cwd";
import { normalizeCwd } from "../paths";

export type CwdSource = "auto" | "pane" | "foreground";

export interface ResolvedTarget {
  target: string | null;
  reason: string;
  /** Field the target came from; null when there is no target. */
  source: LiveSource | null;
  /** Sources tried and rejected before the winning one, with why. */
  attempts: FailedAttempt[];
}

export function findFocusedPane(snapshot: SessionSnapshot): PaneInfo | undefined {
  const { panes, focused_pane_id: focusedPaneId, focused_tab_id: focusedTabId } = snapshot;
  const byId = panes.find(({ pane_id }) => pane_id === focusedPaneId);
  if (byId) return byId;
  const inFocusedTab = panes.find(({ focused, tab_id }) => focused && tab_id === focusedTabId);
  if (inFocusedTab) return inFocusedTab;
  return panes.find(({ focused }) => focused);
}

export function pickCwd(pane: PaneInfo, source: CwdSource): string | null | undefined {
  if (source === "pane") return pane.cwd;
  if (source === "foreground") return pane.foreground_cwd;
  return pane.foreground_cwd ?? pane.cwd;
}

function fieldSource(pane: PaneInfo, source: CwdSource): LiveSource {
  if (source === "pane") return "cwd";
  if (source === "foreground") return "foreground_cwd";
  return pane.foreground_cwd != null ? "foreground_cwd" : "cwd";
}

/**
 * Maps a snapshot to the folder of the focused pane, or null with the reason why not.
 * In auto mode a `live` chain result (probe > foreground_cwd > cwd) replaces the plain field choice.
 */
export function resolveTarget(
  snapshot: SessionSnapshot,
  cwdSource: CwdSource,
  live: ResolvedCwd | undefined,
  platform: NodeJS.Platform,
): ResolvedTarget {
  const pane = findFocusedPane(snapshot);
  if (!pane) return { target: null, reason: "no focused pane in snapshot", source: null, attempts: [] };

  if (cwdSource === "auto" && live) {
    if (live.path === null) {
      return { target: null, reason: `pane ${pane.pane_id} has no usable cwd (auto)`, source: null, attempts: live.attempts };
    }
    return { target: live.path, reason: `pane ${pane.pane_id}`, source: live.source, attempts: live.attempts };
  }

  const raw = pickCwd(pane, cwdSource);
  const target = normalizeCwd(raw, platform);
  if (target === null) {
    return { target: null, reason: `pane ${pane.pane_id} has no usable cwd (${cwdSource}): ${String(raw)}`, source: null, attempts: [] };
  }
  return { target, reason: `pane ${pane.pane_id}`, source: fieldSource(pane, cwdSource), attempts: [] };
}
