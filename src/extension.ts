import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { createLiveCwdProbe, nodeProbeDeps } from "./cwd";
import {
  FOLDER_SWITCH_CONFIRM,
  FOLDER_SWITCH_NOTICE,
  CwdPoller,
  FollowController,
  createHostState,
  isPendingTarget,
  pollIntervalMs,
  reconcilePending,
  routeHerdrEvent,
  switchFolder,
} from "./follow";
import type { FolderPlan, PendingTarget } from "./follow";
import { HerdrClient, resolvePipeName } from "./herdr";
import type { Logger, Subscription } from "./herdr";
import { analyzeHosting, mayFollowAutomatically, readProcessTable, withTimeout } from "./hosting";
import type { HostState } from "./hosting";
import { resolveOnPath } from "./launch";
import { DIAGNOSTIC_TOPICS, createLog, errorText } from "./log";
import { samePath } from "./paths";
import { resolveAnchor } from "./vscode/anchor";
import { AutoLaunch } from "./vscode/autoLaunch";
import { HostingMonitor } from "./vscode/hostingMonitor";
import { selectAnchor } from "./vscode/anchorPath";
import type { AnchorChoice } from "./vscode/anchorPath";
import { affectsSettings, readSettings, setAutoFollow } from "./vscode/settings";
import { StatusBar } from "./vscode/statusBar";
import { createWindowTitleSync } from "./vscode/windowTitle";
import { applyPlan, describeWorkspace, getFolders, isMultiRoot, openFolder } from "./vscode/workspaceAdapter";

const PENDING_KEY = "herdrNavigator.pending";
const TRACKED_KEY = "herdrNavigator.tracked";
const FOCUS_SUBSCRIPTIONS = ["workspace.focused", "tab.focused", "pane.focused", "pane.updated", "workspace.created"];
const CONFIRM_KEY = "herdrNavigator.followHere";
const LAST_FOLLOWED_KEY = "herdrNavigator.lastFollowed";
const NOTICE_SHOWN_KEY = "herdrNavigator.folderSwitchNoticeShown";
const FAILURE_WARNING_MS = 30_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Herdr Navigator");
  const diagnostics = createLog((line) => output.appendLine(line));
  const log: Logger = diagnostics.log;
  // First line of the log: a second activation line in one session marks an extension-host restart.
  log(
    "info",
    `activated herdr-navigator ${String(context.extension.packageJSON.version)} at ${new Date().toISOString()}; workspace ${describeWorkspace()}`,
  );
  const statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);

  let settings = readSettings();
  log("info", `settings: ${JSON.stringify(settings)}`);
  let anchorPath = await resolveAnchor(context);
  let connected = false;
  let subscription: Subscription | undefined;
  let failureTimer: NodeJS.Timeout | undefined;

  const platform = process.platform;
  // A reload we caused leaves the followed folder open and its path persisted: skip the first switch, then forget it so it cannot suppress forever.
  const lastFollowed = context.globalState.get<string>(LAST_FOLLOWED_KEY);
  const [onlyFolder] = getFolders();
  const followedByOwnReload =
    lastFollowed !== undefined && !isMultiRoot() && getFolders().length === 1 && samePath(onlyFolder?.path ?? "", lastFollowed, platform);
  if (lastFollowed !== undefined) {
    log("info", `last followed folder ${lastFollowed}; first switch suppressed=${followedByOwnReload}`);
    await context.globalState.update(LAST_FOLLOWED_KEY, undefined);
  }
  const chosenAnchor = (): AnchorChoice =>
    selectAnchor(getFolders()[0]?.path, anchorPath, context.globalStorageUri.fsPath, platform);
  const syncWindowTitle = createWindowTitleSync({
    platform,
    log,
    config: () => {
      const windowConfig = vscode.workspace.getConfiguration("window");
      return {
        inspect: () => windowConfig.inspect<string>("title"),
        update: (value) => Promise.resolve(windowConfig.update("title", value, vscode.ConfigurationTarget.Workspace)),
      };
    },
  });
  const isNavigatorWindow = (): boolean => {
    const first = getFolders()[0]?.path;
    return first !== undefined && isMultiRoot() && samePath(first, chosenAnchor().path, platform);
  };
  const refreshWindowTitle = (): void => {
    syncWindowTitle(isNavigatorWindow()).catch((err: unknown) => log("warn", `window title: ${errorText(err)}`));
  };
  const socketName = (): string => resolvePipeName(settings.socketPath, process.env, platform);
  const probeDeps = nodeProbeDeps();
  // A fresh client per call, like fetchSnapshot: the socket path setting can change at runtime.
  const liveProbe = createLiveCwdProbe(
    { processInfo: (paneId) => new HerdrClient({ pipeName: socketName(), log }).processInfo(paneId) },
    probeDeps,
  );

  const controller: FollowController = new FollowController({
    platform,
    live: {
      enabled: settings.liveCwdProbe,
      platform: probeDeps.platform,
      probe: (paneId) => liveProbe.probe(paneId, { enabled: true, gitBashPath: settings.gitBashPath }),
    },
    fetchSnapshot: async () => {
      anchorPath = await resolveAnchor(context);
      return new HerdrClient({ pipeName: socketName(), log }).snapshot();
    },
    mode: settings.followMode,
    suppressFirstSwitch: followedByOwnReload,
    switchFolder: async (target, isCurrent) => {
      if (!(await guardAuto(true))) {
        log("info", "openFolder skipped: this window is not confirmed to host herdr");
        return false;
      }
      return switchFolder(
        {
          confirm: confirmFolderSwitch,
          isCurrent,
          persistLastFollowed: (path) => Promise.resolve(context.globalState.update(LAST_FOLLOWED_KEY, path)),
          openFolder: (path) => {
            log("info", `openFolder ${path}: if it is already open in another VS Code window, VS Code focuses that window and this window does not reload`);
            return openFolder(path);
          },
        },
        target,
      );
    },
    applyPlan: async (plan: FolderPlan) => {
      if (plan.kind !== "noop" && !(await guardAuto(plan.kind === "convert"))) {
        log("info", `${plan.kind} skipped: this window is not confirmed to host herdr`);
        if (plan.kind === "convert") await clearPendingTarget(plan.add[plan.add.length - 1]);
        return false;
      }
      const applied = await applyPlan(plan, log);
      if (!applied || plan.kind === "noop") return applied;
      const tracked = plan.kind === "remove" ? null : (plan.add[plan.add.length - 1] ?? null);
      await context.workspaceState.update(TRACKED_KEY, tracked);
      refreshStatus(tracked);
      return true;
    },
    onSnapshot: (snapshot) => {
      poller.observe(snapshot);
      void autoLaunch.observeSnapshot(snapshot).catch((err: unknown) => log("warn", `auto-launch: ${errorText(err)}`));
    },
    persistPendingTarget: (target) => {
      const pending: PendingTarget = { target, at: Date.now(), confirmed: confirmedHere === true };
      return Promise.resolve(context.globalState.update(PENDING_KEY, pending));
    },
    hasGitEntry: (dir) =>
      stat(join(dir, ".git")).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
          throw err;
        },
      ),
    followGitRoot: settings.followGitRoot,
    getFolders,
    isMultiRoot,
    getAnchorPath: () => chosenAnchor().path,
    // undefined means this install never recorded a slot (null is what a remove writes), so the old install's folders are still unreclaimed.
    isAdoptedAnchor: () => chosenAnchor().adopted && context.workspaceState.get(TRACKED_KEY) === undefined,
    autoFollow: settings.autoFollow,
    debounceMs: settings.debounceMs,
    cwdSource: settings.cwdSource,
    log,
  });

  // Herdr pushes no cwd-change event, so a poll of the focused pane's cwd detects a cd; focus events already cover pane switches.
  const poller = new CwdPoller({
    platform,
    fetchSnapshot: () => new HerdrClient({ pipeName: socketName(), log }).snapshot(),
    getCwdSource: () => settings.cwdSource,
    isBusy: () => controller.getState().busy,
    isActive: () => connected && controller.getState().autoFollow && autoAllowed(),
    onChange: () => controller.onFocusEvent(),
    log,
  });

  function refreshStatus(tracked: string | null = controller.getState().trackedPath): void {
    const autoFollow = controller.getState().autoFollow;
    const suppressed = !autoFollow || autoAllowed() ? undefined : suppressionReason();
    statusBar.update(connected, autoFollow, tracked, suppressed);
    poller.start(pollIntervalMs({ connected, autoFollow, host: host.get(), confirmedHere, cwdPollMs: settings.cwdPollMs }));
  }

  // Resume after the one-time extension-host restart: prefer the pending target, else the saved tracked slot.
  const pending = context.globalState.get<unknown>(PENDING_KEY);
  const saved = context.workspaceState.get<string>(TRACKED_KEY);
  const isOpen = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && getFolders().slice(1).some(({ path }) => samePath(path, candidate, platform));
  const pendingTarget = isPendingTarget(pending) ? pending.target : undefined;
  const resumed = [pendingTarget, saved].find(isOpen);
  if (resumed) {
    controller.setTrackedPath(resumed);
    // The converted window has a new workspaceState scope, so the slot must be saved again here.
    await context.workspaceState.update(TRACKED_KEY, resumed);
  }
  // globalState is shared by all windows: clear only an intent this window consumed, or a stale/malformed one.
  const outcome = reconcilePending(pending, getFolders(), Date.now(), platform);
  if (outcome.action !== "none") log("info", `pending: ${outcome.message}`);
  if (outcome.clear) await context.globalState.update(PENDING_KEY, undefined);

  // Only the window whose integrated terminal hosts herdr follows automatically.
  // Any hosting flip (focus recheck, forced scan, terminal events) must update the status and the cwd poller.
  const host = createHostState(() => refreshStatus());
  let confirmedHere = context.workspaceState.get<boolean>(CONFIRM_KEY);
  if (isPendingTarget(pending) && pending.confirmed === true && isOpen(pending.target)) {
    confirmedHere = true;
    await context.workspaceState.update(CONFIRM_KEY, true);
  }
  let manualFollow = false;
  let dismissed = false;
  let confirming: Promise<boolean> | undefined;

  const detectHosting = async (terminals: readonly vscode.Terminal[]): Promise<{ state: HostState; clientPids: readonly number[] }> => {
    try {
      // A terminal whose process never launched must not stall detection; it is skipped after 2 s.
      const shellPids = (
        await Promise.all(terminals.map((t) => withTimeout(t.processId, 2_000)))
      ).filter((pid): pid is number => pid !== undefined);
      if (shellPids.length === 0) return { state: "no", clientPids: [] };
      const { table, msysEdges } = await readProcessTable(platform);
      return analyzeHosting(table, shellPids, msysEdges);
    } catch (err: unknown) {
      log("warn", `hosting detection failed: ${errorText(err)}`);
      return { state: "unknown", clientPids: [] };
    }
  };

  // Every hosting result is published here; lazy checks are rate-limited (5 s while not hosting, 30 s to re-verify).
  const hostingMonitor = new HostingMonitor<vscode.Terminal>({
    terminals: () => vscode.window.terminals,
    scan: detectHosting,
    now: () => Date.now(),
  });
  const requestHosting = (force = false): Promise<void> =>
    hostingMonitor.request(force).then(
      () => undefined,
      (err: unknown) => log("warn", `hosting: ${errorText(err)}`),
    );

  const autoAllowed = (): boolean => mayFollowAutomatically(host.get(), confirmedHere);

  const autoLaunch = new AutoLaunch({
    platform,
    log,
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout), now: () => Date.now() },
    memento: context.workspaceState,
    enabled: () => vscode.workspace.getConfiguration("herdrNavigator").get<boolean>("autoLaunch", true),
    isNavigator: isNavigatorWindow,
    terminals: () => vscode.window.terminals,
    createTerminal: (options) => vscode.window.createTerminal(options),
    editorLocation: vscode.TerminalLocation.Editor,
    resolveHerdr: () => resolveOnPath("herdr", process.platform, process.env),
    rescan: () => requestHosting(true),
    recheck: () => requestHosting(),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        // EPERM means the process exists but belongs to someone else.
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    client: () => new HerdrClient({ pipeName: socketName(), log }),
  });
  context.subscriptions.push({ dispose: () => autoLaunch.dispose() });

  const suppressionReason = (): string =>
    host.get() !== "unknown"
      ? "auto-follow suppressed: this window does not host herdr"
      : confirmedHere === false
        ? "auto-follow suppressed: hosting could not be detected and following here was declined"
        : dismissed
          ? "auto-follow suppressed: hosting could not be detected; run Reconnect to be asked again"
          : "auto-follow waiting: hosting could not be detected; confirmation needed for this window";

  hostingMonitor.subscribe(({ state, clientPids }) => {
    const was = autoAllowed();
    host.set(state);
    log("info", `hosting herdr: ${state}`);
    void autoLaunch.onHosting(state, clientPids).catch((err: unknown) => log("warn", `auto-launch: ${errorText(err)}`));
    refreshStatus();
    if (!was && autoAllowed() && connected) controller.onFocusEvent();
  });

  // When detection failed, the first automatic plan needs the user's say-so for this window; Escape declines until Reconnect.
  const confirmFollowHere = (): Promise<boolean> => {
    if (confirmedHere !== undefined) return Promise.resolve(confirmedHere);
    if (dismissed) return Promise.resolve(false);
    confirming ??= (async () => {
      const yes = "Follow herdr in this window";
      const choice = await vscode.window.showInformationMessage(
        settings.followMode === "folder"
          ? "Herdr Navigator cannot tell whether this window hosts herdr. Following reloads this window on every switch and closes its integrated terminals."
          : "Herdr Navigator cannot tell whether this window hosts herdr. Following changes this window's workspace folders and may convert it to a multi-root workspace, restarting extensions once.",
        { modal: true },
        yes,
        "Not in this window",
      );
      if (choice === undefined) {
        dismissed = true;
      } else {
        confirmedHere = choice === yes;
        await context.workspaceState.update(CONFIRM_KEY, confirmedHere);
      }
      confirming = undefined;
      refreshStatus();
      return confirmedHere === true;
    })();
    return confirming;
  };

  // The first folder-mode switch per installation needs an explicit yes (modal, so it cannot linger); declining abandons that switch and asks again next time.
  const confirmFolderSwitch = async (): Promise<boolean> => {
    if (context.globalState.get<boolean>(NOTICE_SHOWN_KEY) === true) return true;
    const choice = await vscode.window.showInformationMessage(FOLDER_SWITCH_NOTICE, { modal: true }, FOLDER_SWITCH_CONFIRM);
    if (choice !== FOLDER_SWITCH_CONFIRM) return false;
    await context.globalState.update(NOTICE_SHOWN_KEY, true);
    return true;
  };

  // globalState is shared: drop the intent only if it is the one this rejected plan wrote.
  const clearPendingTarget = async (target: string | undefined): Promise<void> => {
    const current = context.globalState.get<unknown>(PENDING_KEY);
    if (target !== undefined && isPendingTarget(current) && samePath(current.target, target, platform)) {
      await context.globalState.update(PENDING_KEY, undefined);
    }
  };

  // Only a conversion forces a fresh scan; other plans reuse the rate-limited cache.
  const guardAuto = async (forceScan: boolean): Promise<boolean> => {
    if (manualFollow) return true;
    await requestHosting(forceScan);
    if (autoAllowed()) return true;
    return host.get() === "unknown" && (await confirmFollowHere());
  };

  const stopSubscription = (): void => {
    subscription?.dispose();
    subscription = undefined;
    clearTimeout(failureTimer);
    failureTimer = undefined;
  };

  // A hosting window follows at once and re-verifies in the background; otherwise detect first (herdr may have started after the terminal was created).
  const whenHosting = (follow: () => void): void => {
    // The controller drops focus events while auto-follow is off, so skip the scan too.
    if (!controller.getState().autoFollow) return;
    const recheck = async (): Promise<boolean> => {
      await requestHosting();
      if (host.get() === "unknown" && !autoAllowed()) return confirmFollowHere();
      return autoAllowed();
    };
    if (autoAllowed()) {
      follow();
      void recheck();
      return;
    }
    void recheck().then((allowed) => {
      if (allowed) follow();
    });
  };

  const onFocus = (): void => whenHosting(() => controller.onFocusEvent());

  const startSubscription = (): void => {
    stopSubscription();
    let pipeName: string;
    try {
      pipeName = socketName();
    } catch (err: unknown) {
      log("error", errorText(err));
      return;
    }
    log("info", `connecting to ${pipeName}`);
    subscription = new HerdrClient({ pipeName, log }).subscribe(FOCUS_SUBSCRIPTIONS, {
      onStarted: () => {
        clearTimeout(failureTimer);
        failureTimer = undefined;
        connected = true;
        refreshStatus();
        void requestHosting(true);
        // Events may have been missed while disconnected.
        onFocus();
      },
      onEvent: ({ event, data }) => {
        // The daemon outlives its clients, so a client starting in an open terminal is seen only by looking again; the monitor's cache bounds the cost.
        if (host.get() !== "yes") void requestHosting();
        routeHerdrEvent(event, {
          // Not logged: title-only pane updates are frequent; the poll logs an actual cwd change.
          pollNow: () => poller.pollNow(),
          onFocusEvent: () => {
            const ids = ["pane_id", "tab_id", "workspace_id"].map((key) => `${key}=${String(data[key] ?? "absent")}`);
            log("info", `herdr event ${event} ${ids.join(" ")}`);
            whenHosting(() => controller.onHerdrEvent(event));
          },
        });
      },
      onDisconnected: () => {
        connected = false;
        refreshStatus();
        void autoLaunch.onHerdrDisconnected().catch((err: unknown) => log("warn", `auto-launch: ${errorText(err)}`));
        failureTimer ??= setTimeout(() => {
          void vscode.window.showWarningMessage("Herdr Navigator cannot reach herdr; see the Herdr Navigator output.");
        }, FAILURE_WARNING_MS);
      },
    });
  };

  context.subscriptions.push(
    { dispose: stopSubscription },
    { dispose: () => poller.stop() },
    // Cancels a pending debounce so no fetch runs after deactivation.
    { dispose: () => controller.setAutoFollow(false) },
    vscode.commands.registerCommand("herdrNavigator.followNow", async () => {
      manualFollow = true;
      try {
        await controller.followNow();
      } finally {
        manualFollow = false;
      }
      refreshStatus();
    }),
    vscode.commands.registerCommand("herdrNavigator.showDiagnostics", () => {
      output.show(true);
      log("info", `diagnostics: workspace ${describeWorkspace()}`);
      for (const topic of DIAGNOSTIC_TOPICS) {
        log("info", `diagnostics: last ${topic} -> ${diagnostics.last(topic) ?? "none yet"}`);
      }
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      autoLaunch.onTerminalOpened(terminal);
      void requestHosting(true);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const reason = terminal.exitStatus?.reason;
      autoLaunch.onTerminalClosed(
        reason === vscode.TerminalExitReason.Shutdown ? "shutdown" : reason === vscode.TerminalExitReason.User ? "user" : "other",
      );
      void requestHosting(true);
    }),
    vscode.commands.registerCommand("herdrNavigator.toggleAutoFollow", () =>
      setAutoFollow(!controller.getState().autoFollow),
    ),
    vscode.commands.registerCommand("herdrNavigator.reconnect", () => {
      dismissed = false;
      confirmedHere = undefined;
      void context.workspaceState.update(CONFIRM_KEY, undefined);
      void requestHosting(true);
      startSubscription();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatus();
      refreshWindowTitle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("window.title")) refreshWindowTitle();
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      controller.setAutoFollow(settings.autoFollow);
      controller.setDebounce(settings.debounceMs);
      controller.setCwdSource(settings.cwdSource);
      controller.setMode(settings.followMode);
      controller.setLiveCwdEnabled(settings.liveCwdProbe);
      controller.setFollowGitRoot(settings.followGitRoot);
      refreshStatus();
      if (settings.socketPath !== previous.socketPath) startSubscription();
    }),
  );

  refreshStatus();
  refreshWindowTitle();
  autoLaunch.start();
  startSubscription();
  void requestHosting(true);
}

export function deactivate(): void {}
