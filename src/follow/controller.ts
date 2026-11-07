import { resolveCwd } from "../cwd/liveCwd";
import type { ProbeResult, ResolvedCwd } from "../cwd/types";
import type { Logger, PaneInfo, SessionSnapshot } from "../herdr";
import { errorText } from "../log";
import { findGitRoot, worktreeParentName } from "./gitRoot";
import { planFolders } from "./planFolders";
import type { FolderLike, FolderPlan } from "./planFolders";
import { findFocusedPane, resolveTarget } from "./resolveTarget";
import type { CwdSource } from "./resolveTarget";

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const FOCUS_EVENTS: ReadonlySet<string> = new Set(["workspace_focused", "tab_focused", "pane_focused"]);

/** Live-cwd chain for auto mode: probe the focused pane's shell, then fall back to herdr's own fields. */
export interface LiveCwdOptions {
  enabled: boolean;
  platform: NodeJS.Platform;
  probe: (paneId: string) => Promise<ProbeResult>;
}

const HINT =
  "hint: target is herdr's reported cwd, which may be the stale spawn directory; check the herdrNavigator.liveCwdProbe and herdrNavigator.gitBashPath settings";

export interface FollowControllerOptions {
  platform: NodeJS.Platform;
  live?: LiveCwdOptions;
  fetchSnapshot: () => Promise<SessionSnapshot>;
  /** Called with each snapshot a follow cycle fetched, before it is resolved. */
  onSnapshot?: (snapshot: SessionSnapshot) => void;
  /** Resolves true when the plan was applied; false when it was rejected. isCurrent turns false if a newer focus superseded the plan while it waited. */
  applyPlan: (plan: FolderPlan, isCurrent: () => boolean) => Promise<boolean>;
  /** Called before a convert plan, which restarts the extension host. */
  persistPendingTarget: (target: string) => Promise<void>;
  /** Checks whether `<dir>/.git` exists; with followGitRoot on, the target snaps to the nearest ancestor that has one. */
  hasGitEntry?: (dir: string) => Promise<boolean>;
  /** Contents of a file; undefined when it is missing or a directory. Names a linked-worktree root after its parent project. */
  readTextFile?: (path: string) => Promise<string | undefined>;
  followGitRoot?: boolean;
  getFolders: () => readonly FolderLike[];
  isMultiRoot: () => boolean;
  getAnchorPath: () => string;
  /** True when the anchor path is a legacy anchor adopted from index 0. */
  isAdoptedAnchor?: () => boolean;
  autoFollow: boolean;
  debounceMs: number;
  cwdSource: CwdSource;
  clock?: Clock;
  log?: Logger;
}

export interface FollowState {
  autoFollow: boolean;
  trackedPath: string | null;
  /** Display name of the tracked slot; undefined shows its basename. */
  trackedName: string | undefined;
  lastTarget: string | null;
  busy: boolean;
  lastError: string | null;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const namedAs = (name: string | undefined): string => (name === undefined ? "" : ` as ${name}`);

function describePlan(plan: FolderPlan): string {
  switch (plan.kind) {
    case "noop":
      return `noop (${plan.reason})`;
    case "convert":
      return `convert: add ${plan.add.join(", ")}`;
    case "replace":
    case "append":
      return `${plan.kind}: index ${plan.index} -> ${plan.add.join(", ")}${namedAs(plan.name)}`;
    case "reclaim":
      return `reclaim: index ${plan.index} (delete ${plan.deleteCount}) -> ${plan.add.join(", ")}${namedAs(plan.name)}`;
    case "remove":
      return `remove: index ${plan.index} (delete ${plan.deleteCount})`;
  }
}

export class FollowController {
  private autoFollow: boolean;
  private debounceMs: number;
  private cwdSource: CwdSource;
  private liveEnabled: boolean;
  private gitRootEnabled: boolean;
  private trackedPath: string | null = null;
  private trackedName: string | undefined;
  private lastTarget: string | null = null;
  private lastError: string | null = null;
  private timer: unknown = null;
  private loop: Promise<void> | null = null;
  private rerun = false;
  private rerunForced = false;
  private cycleForced = false;
  private disposed = false;
  private readonly clock: Clock;

  constructor(private readonly options: FollowControllerOptions) {
    this.autoFollow = options.autoFollow;
    this.debounceMs = options.debounceMs;
    this.cwdSource = options.cwdSource;
    this.liveEnabled = options.live?.enabled ?? false;
    this.gitRootEnabled = options.followGitRoot ?? false;
    this.clock = options.clock ?? realClock;
  }

  /** Clears the debounce timer; no plan is applied afterwards. */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  setAutoFollow(value: boolean): void {
    this.autoFollow = value;
    if (!value) this.cancelTimer();
  }

  setDebounce(ms: number): void {
    this.debounceMs = ms;
  }

  setCwdSource(source: CwdSource): void {
    this.cwdSource = source;
  }

  setLiveCwdEnabled(value: boolean): void {
    this.liveEnabled = value;
  }

  setFollowGitRoot(value: boolean): void {
    this.gitRootEnabled = value;
  }

  /** Restores the tracked slot after an extension-host restart or workspace reopen. */
  setTrackedPath(path: string | null, name?: string): void {
    this.trackedPath = path;
    this.trackedName = name;
  }

  /** The display name a slot for dir gets: the parent project of a linked-worktree root, else undefined (its basename shows). */
  async displayName(dir: string): Promise<string | undefined> {
    const { readTextFile, platform, log } = this.options;
    if (!readTextFile) return undefined;
    try {
      return await worktreeParentName(dir, { readTextFile, platform });
    } catch (err: unknown) {
      log?.("warn", `display name: ${dir} keeps its basename, reading its git metadata failed: ${errorText(err)}`);
      return undefined;
    }
  }

  /** Filters a pushed herdr event name by the focus events, then behaves like onFocusEvent. */
  onHerdrEvent(eventName: string): void {
    if (FOCUS_EVENTS.has(eventName)) this.onFocusEvent();
  }

  onFocusEvent(): void {
    if (!this.autoFollow || this.disposed) return;
    this.cancelTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.run(false);
    }, this.debounceMs);
  }

  /** Follows immediately, regardless of autoFollow and debounce. */
  followNow(): Promise<void> {
    this.cancelTimer();
    return this.run(true);
  }

  /** Resolves once no follow cycle is running. */
  async whenIdle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  getState(): FollowState {
    return {
      autoFollow: this.autoFollow,
      trackedPath: this.trackedPath,
      trackedName: this.trackedName,
      lastTarget: this.lastTarget,
      busy: this.loop !== null,
      lastError: this.lastError,
    };
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // One loop at a time; a request arriving mid-apply reruns with a fresh snapshot so the latest target wins.
  private run(forced: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loop) {
      this.rerun = true;
      this.rerunForced = this.rerunForced || forced;
      return this.loop;
    }
    this.loop = this.drain(forced).finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  private async drain(firstForced: boolean): Promise<void> {
    let forced = firstForced;
    do {
      this.rerun = false;
      this.rerunForced = false;
      this.cycleForced = forced;
      if (forced || this.autoFollow) await this.cycle();
      forced = this.rerunForced;
    } while (this.rerun);
  }

  private async cycle(): Promise<void> {
    const { log } = this.options;
    try {
      const snapshot = await this.options.fetchSnapshot();
      this.options.onSnapshot?.(snapshot);
      const pane = findFocusedPane(snapshot);
      log?.(
        "info",
        `pane: id=${snapshot.focused_pane_id ?? "none"} tab=${snapshot.focused_tab_id ?? "none"} workspace=${snapshot.focused_workspace_id ?? "none"} cwd=${String(pane?.cwd)} foreground_cwd=${pane?.foreground_cwd ?? "absent"} terminal_title=${String(pane?.terminal_title ?? "absent")}`,
      );

      const followed = await this.resolveTargetPath(snapshot, pane);
      if (followed === null) return;
      const { target, name } = followed;
      this.lastTarget = target;

      await this.applyWorkspacePlan(target, name);
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log?.("error", `follow failed: ${errorText(err)}`);
    }
  }

  /** The directory to follow and its display name, or null when there is none or the focus changed while probing. */
  private async resolveTargetPath(snapshot: SessionSnapshot, pane: PaneInfo | undefined): Promise<{ target: string; name: string | undefined } | null> {
    const { log, live } = this.options;
    let resolvedLive: ResolvedCwd | undefined;
    let probeMs: number | undefined;
    // Only the pane that will be followed is probed, once per settled focus.
    if (pane && live && this.cwdSource === "auto") {
      const enabled = this.liveEnabled;
      const started = Date.now();
      const probed = enabled ? await live.probe(pane.pane_id) : undefined;
      if (enabled) probeMs = Date.now() - started;
      // A newer focus arrived during the probe: this result is stale, the rerun resolves the latest pane.
      if (this.rerun) {
        log?.("info", "target: skipped, focus changed during probe");
        return null;
      }
      resolvedLive = resolveCwd(pane, probed, { enabled }, live.platform);
    }

    const resolved = resolveTarget(snapshot, this.cwdSource, resolvedLive, this.options.platform);
    const { reason, source, attempts } = resolved;
    const failed = attempts.map((attempt) => `${attempt.source}: ${attempt.reason}`).join("; ");
    const detail = `${probeMs === undefined ? "" : ` probe=${probeMs}ms`}${failed ? ` failed=[${failed}]` : ""}`;
    if (resolved.target === null) {
      log?.("info", `target: none (${reason})${detail}`);
      return null;
    }
    const { hasGitEntry } = this.options;
    const target =
      this.gitRootEnabled && hasGitEntry
        ? await findGitRoot(resolved.target, { hasGitEntry, platform: this.options.platform })
        : resolved.target;
    const snapped = target === resolved.target ? "" : ` (git root of ${resolved.target})`;
    // Only a worktree root holds the `.git` file, so a subfolder target gets no name and keeps its basename.
    const name = await this.displayName(target);
    log?.("info", `target: ${target}${namedAs(name)} via ${source} (${reason})${snapped}${detail}`);
    if (resolvedLive && source === "cwd") log?.("warn", HINT);
    return { target, name };
  }

  // A newer focus (pending timer or rerun), auto-follow turned off or dispose makes a decision stale.
  private isCurrent(): boolean {
    return !this.disposed && (this.cycleForced || this.autoFollow) && !this.rerun && this.timer === null;
  }

  private async applyWorkspacePlan(target: string, name: string | undefined): Promise<void> {
    const { log } = this.options;
    const plan = planFolders({
      folders: this.options.getFolders(),
      trackedPath: this.trackedPath,
      anchorPath: this.options.getAnchorPath(),
      target,
      targetName: name,
      isMultiRoot: this.options.isMultiRoot(),
      adoptedAnchor: this.options.isAdoptedAnchor?.() ?? false,
      platform: this.options.platform,
    });
    log?.("info", `plan: ${describePlan(plan)}`);
    if (plan.kind === "noop") return;
    if (!this.isCurrent()) {
      log?.("info", `plan: skipped, superseded (${plan.kind})`);
      return;
    }

    if (plan.kind === "convert") {
      await this.options.persistPendingTarget(target);
      if (!this.isCurrent()) {
        log?.("info", `plan: skipped, superseded (${plan.kind})`);
        return;
      }
    }
    const applied = await this.options.applyPlan(plan, () => this.isCurrent());
    log?.("info", `mutation: ${plan.kind} applied=${applied}`);
    if (!applied) {
      log?.("warn", `plan rejected: ${plan.kind}`);
      return;
    }
    this.trackedPath = plan.kind === "remove" ? null : target;
    this.trackedName = plan.kind === "remove" ? undefined : name;
    this.lastError = null;
  }
}
