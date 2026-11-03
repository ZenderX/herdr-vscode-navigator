import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { createLiveCwdProbe } from "./cwd/liveCwd";
import type { LiveCwdProbe } from "./cwd/liveCwd";
import { nodeProbeDeps } from "./cwd/nodeDeps";
import {
  CwdPoller,
  FollowController,
  applyFolderPlan,
  createHostState,
  isPendingTarget,
  planWorkspaceFile,
  pollIntervalMs,
  resumePending,
  routeHerdrEvent,
  switchFolder,
} from "./follow";
import type { FolderPlan, PendingTarget } from "./follow";
import { HerdrClient, resolvePipeName } from "./herdr";
import type { Logger, SessionSnapshot } from "./herdr";
import { HerdrPresence, handleNotInstalledClick, showsNotInstalled } from "./launch/herdrPresence";
import { isLeaseLive, readLease, writeLease } from "./launch/navigatorLease";
import { PLUGIN_HINT_DISMISSED_KEY, PluginHint, handlePluginHintClick, installPluginInTerminal } from "./launch/pluginHint";
import { PENDING_TAKEOVER_MAX_MS } from "./launch/planAutoLaunch";
import type { WindowKind } from "./launch/planAutoLaunch";
import { readRecord } from "./launch/sessionState";
import { detectRefocusPlugin } from "./launch/pluginDetect";
import { TIMEOUT_PROBE, classifyConnectError } from "./launch/serverProbe";
import type { ServerProbe } from "./launch/serverProbe";
import { resolveOnPath } from "./launch/whichHerdr";
import { DIAGNOSTIC_TOPICS, channelWriter, createLog, errorText } from "./log";
import type { DiagnosticLog } from "./log";
import { samePath } from "./paths";
import { withTimeout } from "./hosting";
import { createPaneBusyCheck, nodePaneBusyDeps } from "./restore/paneBusy";
import { createReturnService, fileRecordStore } from "./restore/returnService";
import type { ReturnService } from "./restore/returnService";
import { resolveAnchor } from "./vscode/anchor";
import { AutoLaunch, SESSION_KEY, sessionMemento } from "./vscode/autoLaunch";
import { createFollowConsent } from "./vscode/followConsent";
import type { FollowConsent } from "./vscode/followConsent";
import { createUriHandler } from "./vscode/uriHandler";
import { createHerdrConnection } from "./vscode/herdrConnection";
import type { HerdrConnection } from "./vscode/herdrConnection";
import { HostingMonitor, createCommandStartTrigger, detectHosting } from "./vscode/hostingMonitor";
import { selectAnchor } from "./vscode/anchorPath";
import type { AnchorChoice } from "./vscode/anchorPath";
import { affectsSettings, readSettings, setAutoFollow } from "./vscode/settings";
import type { Settings } from "./vscode/settings";
import { LAUNCH_COMMAND, MAIN_ITEM_PRIORITY, PLUGIN_HINT_PRIORITY, StatusBar, TOGGLE_COMMAND } from "./vscode/statusBar";
import { createWindowTitleSync, focusedLabel } from "./vscode/windowTitle";
import {
  convertToNavigatorWorkspace,
  describeWorkspace,
  getFolders,
  isMultiRoot,
  openFolder,
  workspaceEffects,
  workspaceFileScheme,
} from "./vscode/workspaceAdapter";

const LEASE_FILE = "navigator-lease.json";
const MIGRATION_NOTICE =
  "Herdr Navigator is moving its workspace into a file so VS Code stops restoring a stray extra window. VS Code will ask once whether to save the old untitled workspace; choose Don't Save.";
const MIGRATION_CONFIRM = "Continue";
const REACHABLE_TIMEOUT_MS = 500;
const PENDING_KEY = "herdrNavigator.pending";
const TRACKED_KEY = "herdrNavigator.tracked";
const LAST_FOLLOWED_KEY = "herdrNavigator.lastFollowed";
const TITLE_KEY = "herdrNavigator.windowTitle";

const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };

// VSCODE_PID is the main process, shared by every window of one launch; the per-window session id changes on every reload.
function launchId(log: Logger): string {
  const { VSCODE_PID: pid } = process.env;
  if (pid !== undefined && pid !== "") return pid;
  log("warn", "launch id: VSCODE_PID absent, falling back to sessionId (per window)");
  return vscode.env.sessionId;
}

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

function hasGitEntry(dir: string): Promise<boolean> {
  return stat(join(dir, ".git")).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
      throw err;
    },
  );
}

// A `.git` directory reads as EISDIR: that is a main checkout, not a linked worktree.
function readTextFile(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").then(
    (text) => text,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EISDIR") return undefined;
      throw err;
    },
  );
}

/** The slot the status bar shows; a name absent shows the path's basename. */
interface TrackedSlot {
  path: string | null;
  name?: string;
}

// Only a completed connect proves a server; only a missing socket proves none. A busy pipe or a timeout is doubt.
function probeSocket(pipeName: string, timeoutMs: number, platform: NodeJS.Platform): Promise<ServerProbe> {
  return new Promise((resolve) => {
    const socket = connect(pipeName);
    const done = (result: ServerProbe): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(TIMEOUT_PROBE), timeoutMs);
    socket.once("connect", () => done({ state: "running" }));
    socket.once("error", (err: NodeJS.ErrnoException) => done(classifyConnectError(err.code, platform)));
  });
}

function createTitleRefresher(context: vscode.ExtensionContext, platform: NodeJS.Platform, log: Logger, isNavigatorWindow: () => boolean): (label?: string) => void {
  const syncWindowTitle = createWindowTitleSync({
    platform,
    log,
    recorded: {
      get: () => context.workspaceState.get<string>(TITLE_KEY),
      set: (value) => Promise.resolve(context.workspaceState.update(TITLE_KEY, value)),
    },
    initialLabel: () => readRecord(context.globalState.get<unknown>(SESSION_KEY)).lastSpaceLabel,
    config: () => {
      const windowConfig = vscode.workspace.getConfiguration("window");
      return {
        inspect: () => windowConfig.inspect<string>("title"),
        update: (value) => Promise.resolve(windowConfig.update("title", value, vscode.ConfigurationTarget.Workspace)),
      };
    },
  });
  return (label) => {
    syncWindowTitle(isNavigatorWindow(), label).catch((err: unknown) => log("warn", `window title: ${errorText(err)}`));
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
  windowKind: () => WindowKind;
  windowFolder: () => string | undefined;
  anchorPath: () => string;
  chosenAnchor: () => AnchorChoice;
  requestHosting: (force?: boolean) => Promise<void>;
  newClient: () => HerdrClient;
  socketName: () => string;
  launchId: string;
}

function createAutoLaunch(env: AutoLaunchEnv): AutoLaunch {
  const { context, log, windowFolder } = env;
  const leaseFile = join(context.globalStorageUri.fsPath, LEASE_FILE);
  return new AutoLaunch({
    platform: env.platform,
    log,
    clock: { ...timers, now: () => Date.now() },
    // Shared by all windows: a plain-folder window must read what the navigator recorded.
    memento: sessionMemento(context.globalState, context.workspaceState, () => env.windowKind() === "navigator-untitled"),
    enabled: () => vscode.workspace.getConfiguration("herdrNavigator").get<boolean>("autoLaunch", true),
    isNavigator: env.isNavigatorWindow,
    terminals: () => vscode.window.terminals,
    createTerminal: (options) => vscode.window.createTerminal(options),
    editorLocation: vscode.TerminalLocation.Editor,
    resolveHerdr: () => resolveOnPath("herdr", process.platform, process.env),
    detectPlugin: (herdrPath) => detectRefocusPlugin(nodeProbeDeps().execFile, herdrPath),
    terminalHostsHerdr: async (terminal) => {
      // detectHosting reads a terminal without a shell pid as "no", which proves nothing here.
      try {
        if (!terminal.processId || (await withTimeout(terminal.processId, 2_000)) === undefined) return "unknown";
        return (await detectHosting([{ processId: terminal.processId }], env.platform, log)).state;
      } catch {
        return "unknown";
      }
    },
    serverRunning: async () => {
      // socketName() throws without a socket path; "not running" keeps the re-focus.
      try {
        return (await probeSocket(env.socketName(), REACHABLE_TIMEOUT_MS, env.platform)).state === "running";
      } catch {
        return false;
      }
    },
    rescan: () => env.requestHosting(true),
    recheck: () => env.requestHosting(),
    exitReasons: { shutdown: vscode.TerminalExitReason.Shutdown, user: vscode.TerminalExitReason.User },
    client: env.newClient,
    launchId: env.launchId,
    windowKind: env.windowKind,
    windowFolder,
    lease: {
      read: () => readLease(leaseFile),
      write: (lease) => writeLease(leaseFile, lease),
    },
    convertWindow: async (folder) => {
      await convertToNavigatorWorkspace(env.anchorPath(), folder, log);
    },
    migrateLegacy: async () => {
      const choice = await vscode.window.showInformationMessage(MIGRATION_NOTICE, { modal: true }, MIGRATION_CONFIRM);
      if (choice !== MIGRATION_CONFIRM) return log("info", "auto-launch: legacy migration declined; asked again next start");
      await convertToNavigatorWorkspace(env.chosenAnchor().path, windowFolder() ?? env.chosenAnchor().path, log);
    },
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
  returnService: ReturnService;
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
        // Not logged: herdr pushes pane_updated on every terminal title change; the poll logs an actual cwd change.
        pollNow: () => env.poller.pollNow(),
        record: () => env.returnService.onEvent({ event, data }),
        onFocusEvent: () => {
          const ids = ["pane_id", "tab_id", "workspace_id"].map((key) => `${key}=${String(data[key] ?? "absent")}`);
          log("info", `herdr event ${event} ${ids.join(" ")}`);
          connection.whenHosting(() => controller.onHerdrEvent(event));
        },
      }),
    onFirstDisconnect: () => void env.autoLaunch.onHerdrDisconnected().catch(env.warnAutoLaunch),
    onReconnected: () => void env.returnService.onReconnected(),
    onConnected: () => void env.returnService.reconcile(),
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
  host: ReturnType<typeof createHostState>;
  autoLaunch: AutoLaunch;
  fetchSnapshot: () => Promise<SessionSnapshot>;
  refreshAnchor: () => Promise<void>;
  chosenAnchor: () => AnchorChoice;
  refreshStatus: (slot?: TrackedSlot) => void;
  onSnapshot: (snapshot: SessionSnapshot) => void;
  liveProbe: LiveCwdProbe;
  probePlatform: NodeJS.Platform;
}

function createController(env: ControllerEnv): FollowController {
  const { context, platform, log, consent, liveProbe } = env;
  const settings = env.settings();
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
      platform: env.probePlatform,
      probe: (paneId) => liveProbe.probe(paneId, { enabled: true, gitBashPath: env.settings().gitBashPath }),
    },
    fetchSnapshot: async () => {
      await env.refreshAnchor();
      return env.fetchSnapshot();
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
      const applied = await applyFolderPlan(
        plan,
        workspaceEffects(log),
        {
          hostsHerdr: () => env.host.get() !== "no",
          beginHostingConversion: (folder) => env.autoLaunch.beginHostingConversion(folder),
          recordTakeover: (folder) => env.autoLaunch.recordTakeover(folder),
        },
        platform,
        log,
      );
      if (!applied || plan.kind === "noop") return applied;
      const tracked = plan.kind === "remove" ? null : (plan.add[plan.add.length - 1] ?? null);
      await context.workspaceState.update(TRACKED_KEY, tracked);
      env.refreshStatus({ path: tracked, name: plan.kind === "remove" || plan.kind === "convert" ? undefined : plan.name });
      return true;
    },
    onSnapshot: env.onSnapshot,
    persistPendingTarget: (target) => {
      const pending: PendingTarget = { target, at: Date.now(), confirmed: consent.confirmedHere() === true };
      return Promise.resolve(context.globalState.update(PENDING_KEY, pending));
    },
    hasGitEntry,
    readTextFile,
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
  presence: HerdrPresence;
  pluginHint: PluginHint;
  host: ReturnType<typeof createHostState>;
}

function registerCommands(env: CommandsEnv): vscode.Disposable[] {
  const { controller, consent, autoLaunch, requestHosting, refreshStatus } = env;
  return [
    vscode.commands.registerCommand("herdrNavigator.openHerdrInstall", () =>
      handleNotInstalledClick({
        recheck: () => env.presence.recheck(),
        runInstalled: async () => {
          await vscode.commands.executeCommand(env.host.get() !== "no" ? TOGGLE_COMMAND : LAUNCH_COMMAND);
        },
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
      }),
    ),
    vscode.commands.registerCommand("herdrNavigator.pluginHint", () =>
      handlePluginHintClick({
        showMessage: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        install: () =>
          installPluginInTerminal({
            createTerminal: () => vscode.window.createTerminal({ name: "Herdr plugin install" }),
            onDidCloseTerminal: (listener) => vscode.window.onDidCloseTerminal(listener),
            refresh: () => env.pluginHint.refresh(),
          }),
        dismiss: () => env.pluginHint.dismiss(),
      }),
    ),
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
    vscode.commands.registerCommand("herdrNavigator.launchHerdr", async () => {
      try {
        const result = await autoLaunch.launchNow();
        if (result === "herdr-missing") {
          void vscode.window.showErrorMessage("Herdr Navigator cannot find herdr on PATH.");
        } else if (result === "busy") {
          env.output.info("launch: click ignored while auto-launch is starting herdr");
          vscode.window.setStatusBarMessage("herdr: starting…", 3000);
        }
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Herdr Navigator could not launch herdr: ${errorText(err)}`);
      }
    }),
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
  // Registered before the first await so a URI buffered during activation is replayed to it.
  context.subscriptions.push(vscode.window.registerUriHandler(createUriHandler(log)));
  // First line of the log: a second activation line in one session marks an extension-host restart.
  log("info", `activated herdr-navigator ${String(context.extension.packageJSON.version)} at ${new Date().toISOString()}; workspace ${describeWorkspace()}`);
  const statusBar = new StatusBar(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, MAIN_ITEM_PRIORITY), (id) => new vscode.ThemeColor(id));
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
  const windowKind = (): WindowKind => {
    const folders = getFolders();
    const anchor = chosenAnchor().path;
    // The target is irrelevant to classifying the window; the window's own folder stands in.
    const shape = planWorkspaceFile({ folders, workspaceFileScheme: workspaceFileScheme(), anchorPath: anchor, target: folders[0]?.path ?? anchor, platform });
    if (shape.action === "legacy-untitled") return "navigator-untitled";
    if (shape.action === "already-saved-navigator") return "navigator-saved";
    const plain = shape.action === "write-file-and-open" && folders.length === 1 && !samePath(folders[0].path, anchor, platform);
    return plain && settings.followMode === "workspace" ? "single-folder" : "other";
  };
  const windowFolder = (): string | undefined => getFolders()[isNavigatorWindow() ? 1 : 0]?.path;
  const refreshWindowTitle = createTitleRefresher(context, platform, log, isNavigatorWindow);
  const socketName = (): string => resolvePipeName(settings.socketPath, process.env, platform);
  // A fresh client per call: the socket path setting can change at runtime.
  const newClient = (pipeName = socketName()): HerdrClient => new HerdrClient({ pipeName, log });
  const warnAutoLaunch = (err: unknown): void => log("warn", `auto-launch: ${errorText(err)}`);
  const fetchSnapshot = (): Promise<SessionSnapshot> => newClient().snapshot();

  // Every hosting result is published here; lazy checks reuse a result for 30 s (yes/no) or 5 s (unknown); terminal events and command starts force a scan.
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
  const presence = new HerdrPresence({
    resolve: () => resolveOnPath("herdr", process.platform, process.env),
    subscribeFocus: (listener) => vscode.window.onDidChangeWindowState(({ focused }) => listener(focused)),
    log,
  });
  context.globalState.setKeysForSync([PLUGIN_HINT_DISMISSED_KEY]);
  // Just below the main item's priority with no integer between, so it sits directly right of the auto-follow toggle.
  const hintItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PLUGIN_HINT_PRIORITY);
  hintItem.text = "$(plug)";
  hintItem.tooltip = "Optional herdr plugin: re-focus your last space after a crash or reboot (click for details)";
  hintItem.command = "herdrNavigator.pluginHint";
  const pluginHint = new PluginHint({
    presence,
    detect: (herdrPath) => detectRefocusPlugin(nodeProbeDeps().execFile, herdrPath),
    isDismissed: () => context.globalState.get<boolean>(PLUGIN_HINT_DISMISSED_KEY, false),
    setDismissed: () => Promise.resolve(context.globalState.update(PLUGIN_HINT_DISMISSED_KEY, true)),
    setVisible: (visible) => (visible ? hintItem.show() : hintItem.hide()),
  });
  const launch = launchId(log);
  const autoLaunch = createAutoLaunch({
    launchId: launch,
    context,
    platform,
    log,
    isNavigatorWindow,
    windowKind,
    windowFolder,
    anchorPath: () => anchorPath,
    chosenAnchor,
    requestHosting,
    newClient,
    socketName,
  });
  hostingMonitor.subscribe(({ state, clientPids }) => {
    const was = consent.autoAllowed();
    host.set(state);
    log("info", `hosting herdr: ${state}`);
    void autoLaunch.onHosting(state, clientPids).catch(warnAutoLaunch);
    refreshStatus();
    if (!was && consent.autoAllowed() && connection.isConnected()) controller.onFocusEvent();
  });

  const probeDeps = nodeProbeDeps(log);
  const liveProbe = createLiveCwdProbe({ processInfo: (paneId) => newClient().processInfo(paneId) }, probeDeps);
  const leaseFile = join(context.globalStorageUri.fsPath, LEASE_FILE);
  // Only the lease-holding navigator window records and returns; other windows share globalStorage.
  const returnService = createReturnService({
    platform,
    log,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    pipeName: socketName,
    client: (pipeName) => newClient(pipeName),
    store: fileRecordStore(context.globalStorageUri.fsPath, log),
    isDirectory: (folder) => probeDeps.isDirectory(folder),
    connected: () => connection.isConnected(),
    holdsLease: () => windowKind() === "navigator-saved" && isLeaseLive(readLease(leaseFile), launch, Date.now()),
    pluginState: () => pluginHint.pluginState(),
    busyCheck: () => createPaneBusyCheck(nodePaneBusyDeps(log)),
    probeShells: (panes) => liveProbe.probeShells(panes, { gitBashPath: settings.gitBashPath }),
  });
  const controller = createController({
    liveProbe,
    probePlatform: probeDeps.platform,
    context,
    platform,
    log,
    settings: () => settings,
    followedByOwnReload,
    consent,
    host,
    autoLaunch,
    fetchSnapshot,
    refreshAnchor: async () => void (anchorPath = await resolveAnchor(context)),
    chosenAnchor,
    refreshStatus: (slot) => refreshStatus(slot),
    onSnapshot: (snapshot) => {
      poller.observe(snapshot);
      returnService.observeSnapshot(snapshot);
      void autoLaunch.observeSnapshot(snapshot).catch(warnAutoLaunch);
      refreshWindowTitle(focusedLabel(snapshot));
    },
  });
  // Herdr pushes pane_updated only on a terminal title change, so a cd in a shell whose prompt leaves the title alone (PowerShell, starship, a custom PS1) pushes nothing; the timer compares herdr's cwd only, and a pane_updated also probes the shell, which catches a stock Git Bash prompt's cd while herdr's cwd stays at the spawn folder.
  const poller = new CwdPoller({
    platform,
    fetchSnapshot: () => newClient().snapshot(),
    fetchPane: (paneId) => newClient().pane(paneId),
    getCwdSource: () => settings.cwdSource,
    probeLive: async (paneId) => {
      if (!settings.liveCwdProbe) return null;
      const probed = await liveProbe.probe(paneId, { enabled: true, gitBashPath: settings.gitBashPath });
      return probed.ok ? probed.path : null;
    },
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
    returnService,
  });

  // An applied plan passes its slot: the controller records the slot only once applyPlan resolves.
  function refreshStatus(slot?: TrackedSlot): void {
    const { trackedPath, trackedName, autoFollow } = controller.getState();
    const { path: tracked, name } = slot ?? { path: trackedPath, name: trackedName };
    const connected = connection.isConnected();
    const suppressed = !autoFollow || consent.autoAllowed() ? undefined : consent.suppressionReason();
    statusBar.update(connected, autoFollow, tracked, host.get() !== "no", suppressed, !showsNotInstalled(presence.get()), name);
    poller.start(pollIntervalMs({ connected, autoFollow, host: host.get(), confirmedHere: consent.confirmedHere(), cwdPollMs: settings.cwdPollMs }));
  }

  // The saved file is reopened untouched, so the takeover folder is moved into slot 1 here, before the controller can see a herdr event; auto-launch consumes the record.
  const sessionRecord = readRecord(context.globalState.get<unknown>(SESSION_KEY));
  await resumePending({
    pending: context.globalState.get<unknown>(PENDING_KEY),
    saved: context.workspaceState.get<string>(TRACKED_KEY),
    folders: getFolders,
    takeover: {
      record: { folder: sessionRecord.pendingTakeoverFolder, at: sessionRecord.updatedAt },
      savedNavigator: windowKind() === "navigator-saved",
      maxAgeMs: PENDING_TAKEOVER_MAX_MS,
      updateFolders: workspaceEffects(log).updateFolders,
    },
    now: Date.now(),
    platform,
    displayName: (folder) => controller.displayName(folder),
    setTrackedPath: (path, name) => controller.setTrackedPath(path, name),
    saveTracked: (path) => Promise.resolve(context.workspaceState.update(TRACKED_KEY, path)),
    adoptConfirmation: consent.adopt,
    clearPending: () => Promise.resolve(context.globalState.update(PENDING_KEY, undefined)),
    log,
  });

  // A command may start herdr in a window that is not hosting it yet; look again shortly after.
  const commandStart = createCommandStartTrigger({
    isHosting: () => host.get() === "yes",
    scan: () => void requestHosting(true),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });

  // Disposal runs in push order, so the output channel goes last and teardown can still log.
  context.subscriptions.push(
    { dispose: commandStart.cancel },
    vscode.window.onDidStartTerminalShellExecution(commandStart.onCommandStart),
    statusBar,
    { dispose: connection.stop },
    { dispose: () => poller.stop() },
    { dispose: () => controller.dispose() },
    { dispose: () => hostingMonitor.dispose() },
    { dispose: () => autoLaunch.dispose() },
    { dispose: () => presence.dispose() },
    { dispose: () => pluginHint.dispose() },
    hintItem,
    ...registerCommands({ output, diagnostics, controller, consent, connection, autoLaunch, requestHosting, refreshStatus, presence, pluginHint, host }),
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

  // Subscribed only now: refreshStatus needs the connection and controller built above.
  context.subscriptions.push(presence.onChange(() => refreshStatus()));
  await presence.recheck();
  await pluginHint.refresh();
  refreshStatus();
  refreshWindowTitle();
  autoLaunch.start();
  connection.start();
  void requestHosting(true);
}

export function deactivate(): void {}
