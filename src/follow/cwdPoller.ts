import type { Logger, SessionSnapshot } from "../herdr";
import { errorText } from "../log";
import { normalizeCwd, samePath } from "../paths";
import { realClock } from "./controller";
import type { Clock } from "./controller";
import { findFocusedPane, pickCwd } from "./resolveTarget";
import type { CwdSource } from "./resolveTarget";

export const MIN_POLL_MS = 250;

/** Herdr events that make an immediate poll worthwhile; their payloads are not trusted to carry the cwd. */
export const POLL_EVENTS: ReadonlySet<string> = new Set(["pane_updated", "workspace_created"]);

export interface CwdPollerOptions {
  platform: NodeJS.Platform;
  fetchSnapshot: () => Promise<SessionSnapshot>;
  /** The field the follow reads, so the poll compares what the follow would use. */
  getCwdSource: () => CwdSource;
  /** True while a follow cycle runs; the tick is skipped. */
  isBusy: () => boolean;
  /** Polling continues only while this holds (connected, auto-follow on, hosting). */
  isActive: () => boolean;
  /** The focused pane's directory changed; the caller runs the normal follow cycle. */
  onChange: () => void;
  clock?: Clock;
  log?: Logger;
}

interface Baseline {
  paneId: string;
  cwd: string;
}

/** Detects a `cd` in the focused pane by comparing herdr's reported cwd between snapshots. */
export class CwdPoller {
  private intervalMs = 0;
  private running = false;
  private polling = false;
  private timer: unknown = null;
  private baseline: Baseline | null = null;

  private readonly clock: Clock;

  constructor(private readonly options: CwdPollerOptions) {
    this.clock = options.clock ?? realClock;
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
    this.cancelTimer();
  }

  /** Runs a tick now instead of waiting for the timer; ignored while stopped or a poll is in flight. */
  pollNow(): void {
    if (!this.running || this.polling) return;
    this.cancelTimer();
    void this.tick();
  }

  /** Records the directory a follow cycle just saw as the baseline, so a `cd` made after that snapshot is still detected. */
  observe(snapshot: SessionSnapshot): void {
    if (!this.running) return;
    this.baseline = this.reading(snapshot) ?? this.baseline;
  }

  private reading(snapshot: SessionSnapshot): Baseline | null {
    const pane = findFocusedPane(snapshot);
    if (!pane) return null;
    const cwd = normalizeCwd(pickCwd(pane, this.options.getCwdSource()), this.options.platform);
    return cwd === null ? null : { paneId: pane.pane_id, cwd };
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => void this.tick(), this.intervalMs);
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
    if (!this.polling && !this.options.isBusy()) await this.poll();
    if (this.running && this.timer === null) this.schedule();
  }

  private async poll(): Promise<void> {
    const { platform, log } = this.options;
    this.polling = true;
    try {
      const current = this.reading(await this.options.fetchSnapshot());
      if (!this.running || !current) return;
      const previous = this.baseline;
      this.baseline = current;
      // A different pane is a focus change: focus events already follow it.
      if (!previous || previous.paneId !== current.paneId || samePath(previous.cwd, current.cwd, platform)) return;
      const { paneId, cwd } = current;
      log?.("info", `trigger: pane ${paneId} cwd changed ${previous.cwd} -> ${cwd}`);
      this.options.onChange();
    } catch (err: unknown) {
      log?.("warn", `cwd poll failed: ${errorText(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
