import type { Logger, PaneInfo, SessionSnapshot } from "../herdr";
import { errorText } from "../log";
import { normalizeCwd, samePath } from "../paths";
import { paneHasAgent } from "../restore/returnPlanner";
import { realClock } from "./controller";
import type { Clock } from "./controller";
import { findFocusedPane, pickCwd } from "./resolveTarget";
import type { CwdSource } from "./resolveTarget";

export const MIN_POLL_MS = 250;

/** Herdr events that make an immediate poll worthwhile; the poll reads the cwd source the follow uses, not the payload. */
export const POLL_EVENTS: ReadonlySet<string> = new Set(["pane_updated", "workspace_created"]);

export interface CwdPollerOptions {
  platform: NodeJS.Platform;
  fetchSnapshot: () => Promise<SessionSnapshot>;
  /** One pane by id (`pane.get`); rejects when the pane is gone. */
  fetchPane: (paneId: string) => Promise<PaneInfo>;
  /** The field the follow reads, so the poll compares what the follow would use. */
  getCwdSource: () => CwdSource;
  /** The pane's live folder from the shell probe, or null; called only by a pollNow-triggered poll in auto mode, never by the timer. */
  probeLive?: (paneId: string) => Promise<string | null>;
  /** True while a follow cycle runs; the tick is skipped. */
  isBusy: () => boolean;
  /** Polling continues only while this holds (connected, auto-follow on, hosting). */
  isActive: () => boolean;
  /** The focused pane's directory changed; the caller runs the normal follow cycle. */
  onChange: () => void;
  clock?: Clock;
  /** Milliseconds clock for the pollNow throttle; defaults to Date.now. */
  now?: () => number;
  log?: Logger;
}

interface Baseline {
  paneId: string;
  cwd: string;
  /** Last probe reading for this pane; undefined until an event poll probed it. */
  live?: string;
}

/** Detects a `cd` in the focused pane by comparing herdr's reported cwd between snapshots, and on events also the probed live folder. */
export class CwdPoller {
  private intervalMs = 0;
  private running = false;
  private polling = false;
  private timer: unknown = null;
  private baseline: Baseline | null = null;
  // Learnt from observe() and the snapshot fallback; lets a tick ask for one pane instead of the whole session.
  private focusedPaneId: string | null = null;
  private trailing = false;
  // Set by pollNow, consumed by the next poll: only event-triggered polls run the shell probe.
  private eventPending = false;
  private lastPollStart = Number.NEGATIVE_INFINITY;
  // Bumped by observe(): a poll that started before it holds a staler reading than the baseline it set.
  private generation = 0;

  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(private readonly options: CwdPollerOptions) {
    this.clock = options.clock ?? realClock;
    this.now = options.now ?? Date.now;
  }

  /** Idempotent for an unchanged interval; 0 stops. */
  start(ms: number): void {
    const interval = ms > 0 ? Math.max(MIN_POLL_MS, ms) : 0;
    if (interval === 0) return this.stop();
    if (this.running && interval === this.intervalMs) return;
    this.stop();
    this.intervalMs = interval;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.baseline = null;
    this.focusedPaneId = null;
    this.trailing = false;
    this.eventPending = false;
    this.cancelTimer();
  }

  /** Polls now, or once the last poll is MIN_POLL_MS old; a request during an in-flight poll queues one trailing poll. */
  pollNow(): void {
    if (!this.running) return;
    this.eventPending = true;
    if (this.polling) {
      this.trailing = true;
      return;
    }
    this.pollSoon();
  }

  /** Records the directory a follow cycle just saw as the baseline, so a `cd` made after that snapshot is still detected. */
  observe(snapshot: SessionSnapshot): void {
    if (!this.running) return;
    this.generation += 1;
    const pane = findFocusedPane(snapshot);
    this.focusedPaneId = pane?.pane_id ?? null;
    const current = pane && this.reading(pane);
    if (!current) return;
    const live = this.baseline?.paneId === current.paneId ? this.baseline.live : undefined;
    this.baseline = { ...current, live };
  }

  private reading(pane: PaneInfo): Baseline | null {
    const cwd = normalizeCwd(pickCwd(pane, this.options.getCwdSource()), this.options.platform);
    return cwd === null ? null : { paneId: pane.pane_id, cwd };
  }

  // An agent pane's shell is running the agent, so it cannot have changed folder; its frequent title pushes must not each spawn a probe.
  private async probeLive(pane: PaneInfo): Promise<string | null> {
    const { probeLive, getCwdSource, platform } = this.options;
    if (!probeLive || getCwdSource() !== "auto" || paneHasAgent(pane)) return null;
    return normalizeCwd(await probeLive(pane.pane_id), platform);
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => void this.tick(), this.intervalMs);
  }

  private pollSoon(): void {
    this.cancelTimer();
    const wait = this.lastPollStart + MIN_POLL_MS - this.now();
    if (wait > 0) this.timer = this.clock.setTimeout(() => void this.tick(), wait);
    else void this.tick();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    if (!this.options.isActive()) {
      this.stop();
      return;
    }
    // A restart (stop, start) during an in-flight poll must not start a second one.
    const canPoll = !this.polling && !this.options.isBusy();
    if (canPoll) await this.poll();
    if (!this.running || this.timer !== null) return;
    if (!this.trailing) this.schedule();
    // A skipped tick must defer by a timer: pollSoon could re-enter tick synchronously without bound.
    else if (canPoll) this.pollSoon();
    else this.timer = this.clock.setTimeout(() => void this.tick(), MIN_POLL_MS);
  }

  /** The known focused pane via pane.get; the snapshot only when the id is unknown or the pane is gone or no longer focused. */
  private async focusedPane(): Promise<PaneInfo | undefined> {
    const { fetchPane, fetchSnapshot, log } = this.options;
    const id = this.focusedPaneId;
    if (id !== null) {
      try {
        const pane = await fetchPane(id);
        if (pane.focused !== false) return pane;
      } catch (err: unknown) {
        log?.("debug", `pane.get ${id} failed, using snapshot: ${errorText(err)}`);
      }
    }
    return findFocusedPane(await fetchSnapshot());
  }

  private async poll(): Promise<void> {
    const { platform, log } = this.options;
    this.polling = true;
    this.trailing = false;
    const event = this.eventPending;
    this.eventPending = false;
    this.lastPollStart = this.now();
    const generation = this.generation;
    try {
      const pane = await this.focusedPane();
      if (!this.running || generation !== this.generation) return;
      this.focusedPaneId = pane?.pane_id ?? null;
      const current = pane && this.reading(pane);
      if (!pane || !current) return;
      const live = event ? await this.probeLive(pane) : null;
      if (!this.running || generation !== this.generation) return;
      const previous = this.baseline;
      const samePane = previous?.paneId === current.paneId;
      this.baseline = { ...current, live: live ?? (samePane ? previous.live : undefined) };
      // A different pane is a focus change: focus events already follow it.
      if (!previous || !samePane) return;
      const { paneId, cwd } = current;
      if (!samePath(previous.cwd, cwd, platform)) {
        log?.("info", `trigger: pane ${paneId} cwd changed ${previous.cwd} -> ${cwd}`);
        this.options.onChange();
        return;
      }
      if (live === null) return;
      // No earlier probe of this pane to compare with: the follow cycle re-probes and decides, so a cd back to herdr's stale cwd is not missed.
      if (previous.live !== undefined && samePath(previous.live, live, platform)) return;
      log?.("info", `trigger: pane ${paneId} live cwd ${previous.live ?? "unprobed"} -> ${live}`);
      this.options.onChange();
    } catch (err: unknown) {
      log?.("warn", `cwd poll failed: ${errorText(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
