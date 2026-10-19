import type { TerminalLocation } from "vscode";
import type { HostState } from "../hosting";
import { findWorkspaceIdByLabel } from "../herdr";
import type { Logger, SessionSnapshot } from "../herdr";
import { errorText } from "../log";
import { planAutoLaunch } from "../launch/planAutoLaunch";
import type { LaunchPlan } from "../launch/planAutoLaunch";
import { readRecord, reduce } from "../launch/sessionState";
import type { SessionEvent, SessionRecord } from "../launch/sessionState";

export const SESSION_KEY = "herdrNavigator.session";
const TERMINAL_NAME = "herdr";
const SETTLE_MS = 1500;
// Long enough for a quitting VS Code to end the extension host before a client death is read as the user leaving herdr.
const CONFIRM_LOSS_MS = 5000;
// process.kill(pid, 0) per tracked client: no child process, so the cost is negligible.
const CLIENT_POLL_MS = 2000;
// Bound on follow-up checks after an unknown hosting result, for both loss confirmation and dead-client rechecks.
const MAX_RETRIES = 3;
const RESTORE_POLL_MS = 1000;
const RESTORE_GIVE_UP_MS = 15_000;

/** The slice of vscode.Terminal this module touches. */
export interface AutoLaunchTerminal {
  name: string;
  state: { isInteractedWith: boolean };
  show(): void;
  sendText(text: string, shouldExecute?: boolean): void;
}

export interface AutoLaunchClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface AutoLaunchDeps {
  platform: NodeJS.Platform;
  log: Logger;
  clock: AutoLaunchClock;
  memento: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> };
  enabled: () => boolean;
  isNavigator: () => boolean;
  terminals: () => readonly AutoLaunchTerminal[];
  createTerminal: (options: { name: string; location: TerminalLocation; cwd?: string }) => AutoLaunchTerminal;
  editorLocation: TerminalLocation;
  resolveHerdr: () => Promise<string | undefined>;
  /** Forces a hosting scan that ends in onHosting. */
  rescan: () => Promise<void>;
  /** Asks for a hosting result without forcing a scan; a fresh cached one is reused. */
  recheck: () => Promise<void>;
  /** Whether a process with this native pid still exists; defaults to a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
  /** The `TerminalExitReason` values that count as VS Code shutting down and the user closing the terminal. */
  exitReasons: { shutdown: unknown; user: unknown };
  client: () => { snapshot(): Promise<SessionSnapshot>; focusWorkspace(workspaceId: string): Promise<void> };
}

/** How a terminal closed, as far as shutdown-versus-user attribution needs. */
export type CloseKind = "shutdown" | "user" | "other";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AutoLaunch {
  private record: SessionRecord;
  private lastState: HostState = "unknown";
  private hosting = false;
  private startedAt = 0;
  private settled = false;
  private sweepDone = false;
  private decided = false;
  private restoring = false;
  private disposed = false;
  private shutdownSeen = false;
  private closeSinceSeen: CloseKind | "none" = "none";
  private settleTimer: unknown;
  private lossTimer: unknown;
  private restoreTimer: unknown;
  private clientTimer: unknown;
  private watchedPids: readonly number[] = [];
  private deadChecks = 0;
  private confirmRetries = 0;

  constructor(private readonly deps: AutoLaunchDeps) {
    this.record = readRecord(deps.memento.get(SESSION_KEY));
  }

  /** Opens the settle window; revived terminals may arrive after activation. */
  start(): void {
    this.startedAt = this.deps.clock.now();
    for (const { name, state } of this.deps.terminals()) this.logSeen(name, state.isInteractedWith);
    this.restartSettle();
  }

  onTerminalOpened({ name, state }: AutoLaunchTerminal): void {
    if (this.decided) return;
    this.logSeen(name, state.isInteractedWith);
    // A hosting result from before this terminal appeared cannot speak for it.
    this.sweepDone = false;
    this.restartSettle();
  }

  /** Classifies a terminal's exit reason, then behaves as onTerminalClosed. */
  onTerminalExited(reason: unknown): void {
    const { shutdown, user } = this.deps.exitReasons;
    this.onTerminalClosed(reason === shutdown ? "shutdown" : reason === user ? "user" : "other");
  }

  /** Must run before the hosting rescan the same close triggers, so a shutdown loss is classified correctly. */
  onTerminalClosed(kind: CloseKind): void {
    if (kind === "shutdown") this.shutdownSeen = true;
    if (this.closeSinceSeen !== "other" && this.closeSinceSeen !== "user") this.closeSinceSeen = kind;
  }

  /** Feeds the focused space and its herdr-format cwd into the record while this window hosts herdr. */
  async observeSnapshot(snapshot: SessionSnapshot): Promise<void> {
    if (!this.hosting || this.restoring) return;
    const label = asString(snapshot.workspaces.find(({ workspace_id }) => workspace_id === snapshot.focused_workspace_id)?.label);
    const folder = asString(snapshot.panes.find(({ pane_id }) => pane_id === snapshot.focused_pane_id)?.cwd);
    if (label === undefined || folder === undefined) return;
    if (label === this.record.lastSpaceLabel && folder === this.record.lastFolder) return;
    await this.apply({ type: "spaceFocused", label, folder });
  }

  /** `clientPids` are the herdr clients the scan found; their exit is how leaving herdr in a still-open terminal is noticed. */
  async onHosting(state: HostState, clientPids: readonly number[] = []): Promise<void> {
    this.lastState = state;
    this.sweepDone = true;
    this.deps.clock.clearTimeout(this.clientTimer);
    this.clientTimer = undefined;
    if (state === "yes") {
      this.watchedPids = clientPids;
      this.deadChecks = 0;
      this.watchClients(clientPids);
      this.hosting = true;
      this.closeSinceSeen = "none";
      this.deps.clock.clearTimeout(this.lossTimer);
      this.lossTimer = undefined;
      if (!this.record.herdrWasRunning) await this.apply({ type: "hostingSeen" });
    } else if (state === "unknown" && this.hosting) {
      // A failed scan says nothing about the client; keep watching the last known one.
      this.watchClients(this.watchedPids);
    } else if (state === "no" && this.hosting) {
      this.hosting = false;
      await this.onLoss();
    }
    await this.maybeDecide();
  }

  /** A dropped herdr connection says nothing about the terminal closing, so force the rescan that notices a quit. */
  async onHerdrDisconnected(): Promise<void> {
    if (this.hosting) await this.deps.rescan();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of [this.settleTimer, this.lossTimer, this.restoreTimer, this.clientTimer]) this.deps.clock.clearTimeout(timer);
  }

  // herdr's server is a detached daemon, so leaving the client keeps the socket up; poll the client pids and rescan once all are gone.
  private watchClients(pids: readonly number[]): void {
    if (pids.length === 0 || this.disposed) return;
    this.clientTimer = this.deps.clock.setTimeout(() => {
      if (this.disposed) return;
      if (pids.some((pid) => (this.deps.isAlive ?? processExists)(pid))) return this.watchClients(pids);
      this.clientTimer = undefined;
      // The first dead-client check forces a scan; later ones only ask the cache, and the watch ends after a bounded number.
      const first = this.deadChecks++ === 0;
      if (this.deadChecks > 1 + MAX_RETRIES) return;
      const scan = first ? this.deps.rescan() : this.deps.recheck();
      void scan
        .then(() => {
          // A cached answer publishes nothing, so re-arm here unless the scan already did.
          if (!this.disposed && this.hosting && this.lastState === "unknown" && this.clientTimer === undefined) this.watchClients(pids);
        })
        .catch((err: unknown) => this.deps.log("warn", `auto-launch: ${errorText(err)}`));
    }, CLIENT_POLL_MS);
  }

  private async onLoss(): Promise<void> {
    if (this.shutdownSeen) return this.apply({ type: "hostingLost", reason: "shutdown" });
    if (this.closeSinceSeen === "user") return this.apply({ type: "hostingLost", reason: "terminal-closed-by-user" });
    if (this.closeSinceSeen === "other") return this.apply({ type: "hostingLost", reason: "unknown" });
    // The hosting terminal is still open: only a loss that survives a later rescan counts as herdr quitting.
    this.confirmRetries = 0;
    this.armConfirm();
  }

  private armConfirm(): void {
    this.lossTimer = this.deps.clock.setTimeout(() => {
      void this.confirmLoss().catch((err: unknown) => this.deps.log("warn", `auto-launch: ${errorText(err)}`));
    }, CONFIRM_LOSS_MS);
  }

  private async confirmLoss(): Promise<void> {
    if (this.disposed) return;
    await this.deps.rescan();
    if (this.disposed || this.hosting || this.shutdownSeen) return;
    // Only a definite "no" confirms the loss; a failed detection is retried a bounded number of times.
    if (this.lastState === "unknown" && this.confirmRetries < MAX_RETRIES) {
      this.confirmRetries++;
      this.armConfirm();
      return;
    }
    if (this.lastState !== "no") return;
    await this.apply({ type: "hostingLost", reason: "herdr-exited" });
  }

  private async apply(event: SessionEvent): Promise<void> {
    // Deactivation is not the user leaving herdr; it must never clear the was-running flag.
    if (this.disposed && event.type === "hostingLost") return;
    const next = reduce(this.record, event, this.deps.clock.now());
    if (next === this.record) return;
    this.record = next;
    const reason = event.type === "hostingLost" ? ` ${event.reason}` : "";
    this.deps.log("info", `auto-launch: record herdrWasRunning=${next.herdrWasRunning} (${event.type}${reason})`);
    await this.deps.memento.update(SESSION_KEY, next);
  }

  private logSeen(name: string, interacted: boolean): void {
    this.deps.log("info", `auto-launch: terminal seen ${name} interacted=${interacted} at +${this.deps.clock.now() - this.startedAt}ms`);
  }

  private restartSettle(): void {
    this.settled = false;
    this.deps.clock.clearTimeout(this.settleTimer);
    this.settleTimer = this.deps.clock.setTimeout(() => {
      this.settled = true;
      void this.maybeDecide();
    }, SETTLE_MS);
  }

  private async maybeDecide(): Promise<void> {
    if (this.decided || !this.settled || !this.sweepDone) return;
    this.decided = true;
    try {
      await this.decide();
    } catch (err: unknown) {
      this.deps.log("error", `auto-launch: ${errorText(err)}`);
    }
  }

  private async decide(): Promise<void> {
    const { deps } = this;
    const herdrPath = await deps.resolveHerdr();
    const terminals = deps.terminals();
    const plan = planAutoLaunch({
      platform: deps.platform,
      enabled: deps.enabled(),
      isNavigatorWindow: deps.isNavigator(),
      record: this.record,
      // Undetectable hosting counts as hosting: a duplicate herdr is worse than a missed relaunch.
      herdrHostingNow: this.lastState !== "no",
      herdrPath,
      terminals: terminals.map(({ name, state }) => ({ name, isInteractedWith: state.isInteractedWith })),
      terminalName: TERMINAL_NAME,
    });
    this.logPlan(plan);
    if (plan.action === "none") return;

    if (plan.action === "reuse") {
      const terminal = terminals[plan.terminalIndex];
      if (!terminal) return;
      terminal.show();
      terminal.sendText(plan.command, true);
    } else {
      const terminal = deps.createTerminal({
        name: plan.name,
        location: deps.editorLocation,
        ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
      });
      terminal.sendText(plan.command, true);
    }
    if (plan.focusLabel !== undefined) this.restoreSpace(plan.focusLabel, this.record.lastFolder);
  }

  private logPlan(plan: LaunchPlan): void {
    const detail =
      plan.action === "none"
        ? plan.reason
        : `${plan.action === "reuse" ? `terminal ${plan.terminalIndex}` : plan.name} cwd=${plan.cwd ?? "none"} focus=${plan.focusLabel ?? "none"}`;
    const unknown = this.lastState === "unknown" ? " (hosting unknown)" : "";
    this.deps.log("info", `auto-launch: ${plan.action} ${detail}${unknown}`);
  }

  // Polls until herdr is hosted and answers, then focuses the remembered space once; gives up after a bounded wait.
  private restoreSpace(label: string, lastFolder: string | undefined): void {
    const { deps } = this;
    const deadline = deps.clock.now() + RESTORE_GIVE_UP_MS;
    const finish = (message: string): void => {
      this.restoring = false;
      deps.log("info", `auto-launch: ${message}`);
    };
    const attempt = async (): Promise<void> => {
      try {
        if (this.disposed) return;
        if (!this.hosting) await deps.rescan();
        if (this.disposed) return;
        if (this.hosting) {
          const client = deps.client();
          const snapshot = await client.snapshot();
          if (this.disposed) return;
          const id = findWorkspaceIdByLabel(snapshot, label, lastFolder);
          if (id === undefined) return finish(`space "${label}" not found; focus left to herdr`);
          await client.focusWorkspace(id);
          return finish(`focused space "${label}" (${id})`);
        }
      } catch (err: unknown) {
        deps.log("warn", `auto-launch: space restore attempt failed: ${errorText(err)}`);
      }
      if (this.disposed) return;
      if (deps.clock.now() >= deadline) return finish(`gave up focusing space "${label}"`);
      this.restoreTimer = deps.clock.setTimeout(() => void attempt(), RESTORE_POLL_MS);
    };
    this.restoring = true;
    this.restoreTimer = deps.clock.setTimeout(() => void attempt(), RESTORE_POLL_MS);
  }
}
