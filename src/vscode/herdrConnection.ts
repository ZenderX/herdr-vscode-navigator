import type { HostState } from "../hosting";
import type { Logger, Subscription } from "../herdr";
import type { HerdrEvent, SubscriptionHandlers } from "../herdr/types";
import { errorText } from "../log";

const FOCUS_SUBSCRIPTIONS = ["workspace.focused", "tab.focused", "pane.focused", "pane.updated", "workspace.created"];
const FAILURE_WARNING_MS = 30_000;

export interface HerdrConnectionDeps {
  /** Throws when the socket path setting cannot be resolved. */
  pipeName: () => string;
  subscribe: (pipeName: string, topics: readonly string[], handlers: SubscriptionHandlers) => Subscription;
  log: Logger;
  clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  warnUnreachable: () => void;
  refreshStatus: () => void;
  host: { get: () => HostState };
  autoFollowEnabled: () => boolean;
  requestHosting: (force?: boolean) => Promise<void>;
  autoAllowed: () => boolean;
  confirmFollowHere: () => Promise<boolean>;
  /** A focus change that the controller should follow now. */
  onFocusEvent: () => void;
  onEvent: (event: HerdrEvent) => void;
  /** Runs once per disconnected streak, not on every failed reconnect attempt. */
  onFirstDisconnect: () => void;
}

export interface HerdrConnection {
  isConnected: () => boolean;
  /** (Re)starts the subscription; the status shows disconnected until herdr answers. */
  start: () => void;
  stop: () => void;
  /** Follows at once in a hosting window, otherwise detects hosting first. */
  whenHosting: (follow: () => void) => void;
}

export function createHerdrConnection(deps: HerdrConnectionDeps): HerdrConnection {
  const { log, clock } = deps;
  let connected = false;
  let down = false;
  let subscription: Subscription | undefined;
  let failureTimer: unknown;

  const clearFailureTimer = (): void => {
    clock.clearTimeout(failureTimer);
    failureTimer = undefined;
  };

  const stop = (): void => {
    subscription?.dispose();
    subscription = undefined;
    connected = false;
    clearFailureTimer();
  };

  // A hosting window follows at once and re-verifies in the background; otherwise detect first (herdr may have started after the terminal was created).
  const whenHosting = (follow: () => void): void => {
    // The controller drops focus events while auto-follow is off, so skip the scan too.
    if (!deps.autoFollowEnabled()) return;
    const recheck = async (): Promise<boolean> => {
      await deps.requestHosting();
      if (deps.host.get() === "unknown" && !deps.autoAllowed()) return deps.confirmFollowHere();
      return deps.autoAllowed();
    };
    const failed = (err: unknown): void => log("warn", `hosting recheck: ${errorText(err)}`);
    if (deps.autoAllowed()) {
      follow();
      recheck().catch(failed);
      return;
    }
    recheck()
      .then((allowed) => {
        if (allowed) follow();
      })
      .catch(failed);
  };

  const start = (): void => {
    stop();
    deps.refreshStatus();
    let pipeName: string;
    try {
      pipeName = deps.pipeName();
    } catch (err: unknown) {
      log("error", errorText(err));
      return;
    }
    log("info", `connecting to ${pipeName}`);
    subscription = deps.subscribe(pipeName, FOCUS_SUBSCRIPTIONS, {
      onStarted: () => {
        clearFailureTimer();
        down = false;
        connected = true;
        deps.refreshStatus();
        void deps.requestHosting(true);
        // Events may have been missed while disconnected.
        whenHosting(deps.onFocusEvent);
      },
      onEvent: (event) => {
        // The daemon outlives its clients, so a client starting in an open terminal is seen only by looking again; the monitor's cache bounds the cost.
        if (deps.host.get() !== "yes") void deps.requestHosting();
        deps.onEvent(event);
      },
      onDisconnected: () => {
        connected = false;
        deps.refreshStatus();
        if (!down) {
          down = true;
          deps.onFirstDisconnect();
        }
        failureTimer ??= clock.setTimeout(deps.warnUnreachable, FAILURE_WARNING_MS);
      },
    });
  };

  return { isConnected: () => connected, start, stop, whenHosting };
}
