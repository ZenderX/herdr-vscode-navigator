import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { createLiveCwdProbe } from "./cwd/liveCwd";
import { nodeProbeDeps } from "./cwd/nodeDeps";
import {
  CwdPoller,
  FollowController,
  createHostState,
  isPendingTarget,
  pollIntervalMs,
  resumePending,
  routeHerdrEvent,
  switchFolder,
} from "./follow";
import type { FolderPlan, PendingTarget } from "./follow";
import { HerdrClient, resolvePipeName } from "./herdr";
import type { Logger, SessionSnapshot } from "./herdr";
import { resolveOnPath } from "./launch/whichHerdr";
import { DIAGNOSTIC_TOPICS, channelWriter, createLog, errorText } from "./log";
import type { DiagnosticLog } from "./log";
import { samePath } from "./paths";
import { resolveAnchor } from "./vscode/anchor";
import { AutoLaunch } from "./vscode/autoLaunch";
import { createFollowConsent } from "./vscode/followConsent";
import type { FollowConsent } from "./vscode/followConsent";
import { createHerdrConnection } from "./vscode/herdrConnection";
import type { HerdrConnection } from "./vscode/herdrConnection";
import { HostingMonitor, detectHosting } from "./vscode/hostingMonitor";
import { selectAnchor } from "./vscode/anchorPath";
import type { AnchorChoice } from "./vscode/anchorPath";
import { affectsSettings, readSettings, setAutoFollow } from "./vscode/settings";
import type { Settings } from "./vscode/settings";
import { StatusBar } from "./vscode/statusBar";
import { createWindowTitleSync } from "./vscode/windowTitle";
import { applyPlan, describeWorkspace, getFolders, isMultiRoot, openFolder } from "./vscode/workspaceAdapter";

const PENDING_KEY = "herdrNavigator.pending";
const TRACKED_KEY = "herdrNavigator.tracked";
const LAST_FOLLOWED_KEY = "herdrNavigator.lastFollowed";

const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };

// A reload we caused leaves the followed folder open and its path persisted: skip the first switch, then forget it so it cannot suppress forever.
async function consumeOwnReload(context: vscode.ExtensionContext, platform: NodeJS.Platform, log: Logger): Promise<boolean> {
  const lastFollowed = context.globalState.get<string>(LAST_FOLLOWED_KEY);
  if (lastFollowed === undefined) return false;
  const [onlyFolder] = getFolders();
  const suppressed = !isMultiRoot() && getFolders().length === 1 && samePath(onlyFolder?.path ?? "", lastFollowed, platform);
  log("info", `last followed folder ${lastFollowed}; first switch suppressed=${suppressed}`);
  await context.globalState.update(LAST_FOLLOWED_KEY, undefined);
  return suppressed;
}

function createTitleRefresher(platform: NodeJS.Platform, log: Logger, isNavigatorWindow: () => boolean): () => void {
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
  return () => {
    syncWindowTitle(isNavigatorWindow()).catch((err: unknown) => log("warn", `window title: ${errorText(err)}`));
  };
}

function applySettings(controller: FollowController, settings: Settings): void {
  controller.setAutoFollow(settings.autoFollow);
  controller.setDebounce(settings.debounceMs);
  controller.setCwdSource(settings.cwdSource);
  controller.setMode(settings.followMode);
  controller.setLiveCwdEnabled(settings.liveCwdProbe);
  controller.setFollowGitRoot(settings.followGitRoot);
}

interface AutoLaunchEnv {
  context: vscode.ExtensionContext;
  platform: NodeJS.Platform;
  log: Logger;
  isNavigatorWindow: () => boolean;
  requestHosting: (force?: boolean) => Promise<void>;
  newClient: () => HerdrClient;
}

function createAutoLaunch(env: AutoLaunchEnv): AutoLaunch {
  return new AutoLaunch({
    platform: env.platform,
    log: env.log,
    clock: { ...timers, now: () => Date.now() },
    memento: env.context.workspaceState,
    enabled: () => vscode.workspace.getConfiguration("herdrNavigator").get<boolean>("autoLaunch", true),
    isNavigator: env.isNavigatorWindow,
    terminals: () => vscode.window.terminals,
    createTerminal: (options) => vscode.window.createTerminal(options),
    editorLocation: vscode.TerminalLocation.Editor,
    resolveHerdr: () => resolveOnPath("herdr", process.platform, process.env),
    rescan: () => env.requestHosting(true),
    recheck: () => env.requestHosting(),
    exitReasons: { shutdown: vscode.TerminalExitReason.Shutdown, user: vscode.TerminalExitReason.User },
    client: env.newClient,
  });
}

interface ConnectionEnv {
  log: Logger;
  socketName: () => string;
  newClient: (pipeName?: string) => HerdrClient;
  host: ReturnType<typeof createHostState>;
  consent: FollowConsent;
  requestHosting: (force?: boolean) => Promise<void>;
  controller: FollowController;
  poller: CwdPoller;
  autoLaunch: AutoLaunch;
  refreshStatus: () => void;
  warnAutoLaunch: (err: unknown) => void;
}

function createConnection(env: ConnectionEnv): HerdrConnection {
  const { log, controller, consent } = env;
  const connection: HerdrConnection = createHerdrConnection({
    pipeName: env.socketName,
    subscribe: (pipeName, topics, handlers) => env.newClient(pipeName).subscribe(topics, handlers),
    log,
    clock: timers,
    warnUnreachable: () => void vscode.window.showWarningMessage("Herdr Navigator cannot reach herdr; see the Herdr Navigator output."),
    refreshStatus: env.refreshStatus,
    host: env.host,
    autoFollowEnabled: () => controller.getState().autoFollow,
    requestHosting: env.requestHosting,
    autoAllowed: consent.autoAllowed,
    confirmFollowHere: consent.confirmFollowHere,
    onFocusEvent: () => controller.onFocusEvent(),
    onEvent: ({ event, data }) =>
      routeHerdrEvent(event, {
        // Not logged: title-only pane updates are frequent; the poll logs an actual cwd change.
        pollNow: () => env.poller.pollNow(),
        onFocusEvent: () => {
          const ids = ["pane_id", "tab_id", "workspace_id"].map((key) => `${key}=${String(data[key] ?? "absent")}`);
          log("info", `herdr event ${event} ${ids.join(" ")}`);
          connection.whenHosting(() => controller.onHerdrEvent(event));
        },
      }),
    onFirstDisconnect: () => void env.autoLaunch.onHerdrDisconnected().catch(env.warnAutoLaunch),
  });
  return connection;
}

interface ControllerEnv {
  context: vscode.ExtensionContext;
  platform: NodeJS.Platform;
  log: Logger;
  /** Live getter: the git bash path is read per probe so a runtime setting change applies without a reload. */
  settings: () => Settings;
  followedByOwnReload: boolean;
  consent: FollowConsent;
  newClient: () => HerdrClient;
  refreshAnchor: () => Promise<void>;
  chosenAnchor: () => AnchorChoice;
  refreshStatus: (tracked?: string | null) => void;
  onSnapshot: (snapshot: SessionSnapshot) => void;
}

function createController(env: ControllerEnv): FollowController {
  const { context, platform, log, consent } = env;
  const settings = env.settings();
  const probeDeps = nodeProbeDeps();
  const liveProbe = createLiveCwdProbe({ processInfo: (paneId) => env.newClient().processInfo(paneId) }, probeDeps);
  // globalState is shared: drop the intent only if it is the one this rejected plan wrote.
  const clearPendingTarget = async (target: string | undefined): Promise<void> => {
    const current = context.globalState.get<unknown>(PENDING_KEY);
    if (target !== undefined && isPendingTarget(current) && samePath(current.target, target, platform)) {
      await context.globalState.update(PENDING_KEY, undefined);
    }
  };
  return new FollowController({
    platform,
    live: {
      enabled: settings.liveCwdProbe,
      platform: probeDeps.platform,
      probe: (paneId) => liveProbe.probe(paneId, { enabled: true, gitBashPath: env.settings().gitBashPath }),
    },
    fetchSnapshot: async () => {
      await env.refreshAnchor();
      return env.newClient().snapshot();
    },
    mode: settings.followMode,
    suppressFirstSwitch: env.followedByOwnReload,
    switchFolder: async (target, isCurrent) => {
      if (!(await consent.guardAuto(true))) {
        log("info", "openFolder skipped: this window is not confirmed to host herdr");
        return false;
      }
      return switchFolder(
        {
          confirm: consent.confirmFolderSwitch,
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
    applyPlan: async (plan: FolderPlan, isCurrent) => {
      if (plan.kind !== "noop") {
        const allowed = await consent.guardAuto(plan.kind === "convert");
        if (!allowed || !isCurrent()) {
          log("info", `${plan.kind} skipped: ${allowed ? "superseded by a newer focus" : "this window is not confirmed to host herdr"}`);
          if (plan.kind === "convert") await clearPendingTarget(plan.add[plan.add.length - 1]);
          return false;
        }
      }
      const applied = await applyPlan(plan, log);
      if (!applied || plan.kind === "noop") return applied;
      const tracked = plan.kind === "remove" ? null : (plan.add[plan.add.length - 1] ?? null);
      await context.workspaceState.update(TRACKED_KEY, tracked);
      env.refreshStatus(tracked);
      return true;
    },
    onSnapshot: env.onSnapshot,
    persistPendingTarget: (target) => {
      const pending: PendingTarget = { target, at: Date.now(), confirmed: consent.confirmedHere() === true };
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
    getAnchorPath: () => env.chosenAnchor().path,
    // undefined means this install never recorded a slot (null is what a remove writes), so the old install's folders are still unreclaimed.
    isAdoptedAnchor: () => env.chosenAnchor().adopted && context.workspaceState.get(TRACKED_KEY) === undefined,
    autoFollow: settings.autoFollow,
    debounceMs: settings.debounceMs,
    cwdSource: settings.cwdSource,
    log,
  });
}

interface CommandsEnv {
  output: vscode.LogOutputChannel;
  diagnostics: DiagnosticLog;
  controller: FollowController;
  consent: FollowConsent;
  connection: HerdrConnection;
  autoLaunch: AutoLaunch;
  requestHosting: (force?: boolean) => Promise<void>;
  refreshStatus: () => void;
}

function registerCommands(env: CommandsEnv): vscode.Disposable[] {
  const { controller, consent, autoLaunch, requestHosting, refreshStatus } = env;
  return [
    vscode.commands.registerCommand("herdrNavigator.followNow", async () => {
      consent.setManualFollow(true);
      try {
        await controller.followNow();
      } finally {
        consent.setManualFollow(false);
      }
      refreshStatus();
    }),
    vscode.commands.registerCommand("herdrNavigator.showDiagnostics", () => {
      env.output.show(true);
      env.output.info(`diagnostics: workspace ${describeWorkspace()}`);
      for (const topic of DIAGNOSTIC_TOPICS) {
        env.output.info(`diagnostics: last ${topic} -> ${env.diagnostics.last(topic) ?? "none yet"}`);
      }
    }),
    vscode.commands.registerCommand("herdrNavigator.toggleAutoFollow", () => setAutoFollow(!controller.getState().autoFollow)),
    vscode.commands.registerCommand("herdrNavigator.reconnect", () => {
      void consent.reset();
      void requestHosting(true);
      env.connection.start();
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      autoLaunch.onTerminalOpened(terminal);
      void requestHosting(true);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      autoLaunch.onTerminalExited(terminal.exitStatus?.reason);
      void requestHosting(true);
    }),
  ];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Herdr Navigator", { log: true });
  const diagnostics = createLog(channelWriter(output));
  const log: Logger = diagnostics.log;
  // First line of the log: a second activation line in one session marks an extension-host restart.
  log("info", `activated herdr-navigator ${String(context.extension.packageJSON.version)} at ${new Date().toISOString()}; workspace ${describeWorkspace()}`);
  const statusBar = new StatusBar();
  let settings = readSettings();
  // Path settings can name private locations: log only whether they are set.
  log("info", `settings: ${JSON.stringify({ ...settings, socketPath: settings.socketPath !== "", gitBashPath: settings.gitBashPath !== "" })}`);
  let anchorPath = await resolveAnchor(context);
  const platform = process.platform;
  const followedByOwnReload = await consumeOwnReload(context, platform, log);
  const chosenAnchor = (): AnchorChoice => selectAnchor(getFolders()[0]?.path, anchorPath, context.globalStorageUri.fsPath, platform);
  const isNavigatorWindow = (): boolean => {
    const first = getFolders()[0]?.path;
    return first !== undefined && isMultiRoot() && samePath(first, chosenAnchor().path, platform);
  };
  const refreshWindowTitle = createTitleRefresher(platform, log, isNavigatorWindow);
  const socketName = (): string => resolvePipeName(settings.socketPath, process.env, platform);
  // A fresh client per call: the socket path setting can change at runtime.
  const newClient = (pipeName = socketName()): HerdrClient => new HerdrClient({ pipeName, log });
  const warnAutoLaunch = (err: unknown): void => log("warn", `auto-launch: ${errorText(err)}`);

  // Every hosting result is published here; lazy checks are rate-limited (5 s while not hosting, 30 s to re-verify).
  const hostingMonitor = new HostingMonitor<vscode.Terminal>({
    terminals: () => vscode.window.terminals,
    scan: (terminals) => detectHosting(terminals, platform, log),
    now: () => Date.now(),
  });
  const requestHosting = (force = false): Promise<void> =>
    hostingMonitor.request(force).then(
      () => undefined,
      (err: unknown) => log("warn", `hosting: ${errorText(err)}`),
    );
  // Only the window whose integrated terminal hosts herdr follows automatically.
  // Any hosting flip (focus recheck, forced scan, terminal events) must update the status and the cwd poller.
  const host = createHostState(() => refreshStatus());
  const consent = createFollowConsent({
    host,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    askModal: (message, ...items) => vscode.window.showInformationMessage(message, { modal: true }, ...items),
    followMode: () => settings.followMode,
    requestHosting,
    refreshStatus: () => refreshStatus(),
  });
  const autoLaunch = createAutoLaunch({ context, platform, log, isNavigatorWindow, requestHosting, newClient });
  hostingMonitor.subscribe(({ state, clientPids }) => {
    const was = consent.autoAllowed();
    host.set(state);
    log("info", `hosting herdr: ${state}`);
    void autoLaunch.onHosting(state, clientPids).catch(warnAutoLaunch);
    refreshStatus();
    if (!was && consent.autoAllowed() && connection.isConnected()) controller.onFocusEvent();
  });

  const controller = createController({
    context,
    platform,
    log,
    settings: () => settings,
    followedByOwnReload,
    consent,
    newClient,
    refreshAnchor: async () => void (anchorPath = await resolveAnchor(context)),
    chosenAnchor,
    refreshStatus: (tracked) => refreshStatus(tracked),
    onSnapshot: (snapshot) => {
      poller.observe(snapshot);
      void autoLaunch.observeSnapshot(snapshot).catch(warnAutoLaunch);
    },
  });
  // Herdr pushes no cwd-change event, so a poll of the focused pane's cwd detects a cd; focus events already cover pane switches.
  const poller = new CwdPoller({
    platform,
    fetchSnapshot: () => newClient().snapshot(),
    getCwdSource: () => settings.cwdSource,
    isBusy: () => controller.getState().busy,
    isActive: () => connection.isConnected() && controller.getState().autoFollow && consent.autoAllowed(),
    onChange: () => controller.onFocusEvent(),
    log,
  });
  const connection = createConnection({
    log,
    socketName,
    newClient,
    host,
    consent,
    requestHosting,
    controller,
    poller,
    autoLaunch,
    refreshStatus: () => refreshStatus(),
    warnAutoLaunch,
  });

  function refreshStatus(tracked: string | null = controller.getState().trackedPath): void {
    const connected = connection.isConnected();
    const autoFollow = controller.getState().autoFollow;
    const suppressed = !autoFollow || consent.autoAllowed() ? undefined : consent.suppressionReason();
    statusBar.update(connected, autoFollow, tracked, suppressed);
    poller.start(pollIntervalMs({ connected, autoFollow, host: host.get(), confirmedHere: consent.confirmedHere(), cwdPollMs: settings.cwdPollMs }));
  }

  await resumePending({
    pending: context.globalState.get<unknown>(PENDING_KEY),
    saved: context.workspaceState.get<string>(TRACKED_KEY),
    folders: getFolders(),
    now: Date.now(),
    platform,
    setTrackedPath: (path) => controller.setTrackedPath(path),
    saveTracked: (path) => Promise.resolve(context.workspaceState.update(TRACKED_KEY, path)),
    adoptConfirmation: consent.adopt,
    clearPending: () => Promise.resolve(context.globalState.update(PENDING_KEY, undefined)),
    log,
  });

  // Disposal runs in push order, so the output channel goes last and teardown can still log.
  context.subscriptions.push(
    statusBar,
    { dispose: connection.stop },
    { dispose: () => poller.stop() },
    { dispose: () => controller.dispose() },
    { dispose: () => hostingMonitor.dispose() },
    { dispose: () => autoLaunch.dispose() },
    ...registerCommands({ output, diagnostics, controller, consent, connection, autoLaunch, requestHosting, refreshStatus }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatus();
      refreshWindowTitle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("window.title")) refreshWindowTitle();
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      applySettings(controller, settings);
      refreshStatus();
      if (settings.socketPath !== previous.socketPath) connection.start();
    }),
    output,
  );

  refreshStatus();
  refreshWindowTitle();
  autoLaunch.start();
  connection.start();
  void requestHosting(true);
}

export function deactivate(): void {}
