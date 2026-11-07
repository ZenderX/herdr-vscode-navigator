import { NAVIGATOR_GIT_SETTINGS } from "../follow/planFolders";
import type { Logger } from "../herdr";
import { errorText } from "../log";
import { isSameOrInside, samePath } from "../paths";
import { decideScm, guardToggles, initOffer } from "../scm/decision";
import type { ScmDecision, ScmHoldReason, ToggleAttempt } from "../scm/decision";
import type { ConfigQueue } from "./configQueue";

const GIT_EXTENSION_ID = "vscode.git";
const TOGGLE_RECORD_KEY = "herdrNavigator.gitEnabledToggle";
const INIT_OFFER_KEY = "herdrNavigator.initOffer";
const IGNORED_KEY = "ignoredRepositories";
const WRITE_RETRIES = 3;

const HOLD_CAUSE: Record<ScmHoldReason, string> = {
  "survived-false-write": "it outlived the git.enabled false, so its own folder's settings keep Git on there",
  burst: "Git keeps reopening it right after each drop",
};

export interface GitUri {
  readonly fsPath: string;
}

export interface GitDisposable {
  dispose(): void;
}

export type GitEvent<T> = (listener: (value: T) => void) => GitDisposable;

export interface GitRepository {
  readonly rootUri: GitUri;
}

/** The part of the Git extension's API this module uses; `@types/vscode` does not carry it. */
export interface GitApi {
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: GitEvent<"uninitialized" | "initialized">;
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: GitEvent<GitRepository>;
  init(root: GitUri, options?: { defaultBranch?: string }): Thenable<GitRepository | null>;
  openRepository(root: GitUri): Thenable<GitRepository | null>;
}

export interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: GitEvent<boolean>;
  getAPI(version: 1): GitApi;
}

export interface GitExtensionHandle {
  activate(): Thenable<GitExtensionExports | undefined>;
}

/** `update` writes at Workspace scope only; the VS Code binding owns that target and the `git` section. */
export interface GitConfig {
  get(key: string): unknown;
  inspect(key: string): { workspaceValue?: unknown; globalValue?: unknown } | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const stringEntries = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

interface IgnoredListInput {
  globalValue: unknown;
  workspaceValue: unknown;
  owned: string | null;
  strays: readonly string[];
  followed: string | undefined;
  platform: NodeJS.Platform;
}

/** Earlier entries stay, as a root that left the list could reopen; only what would stop the followed folder's own repository goes. */
function nextIgnoredList({ globalValue, workspaceValue, owned, strays, followed, platform }: IgnoredListInput): string[] | undefined {
  const own = stringEntries(globalValue);
  const stopsFollowed = (entry: string): boolean =>
    samePath(entry, owned, platform) || (isSameOrInside(followed, entry, platform) && (owned === null || isSameOrInside(entry, owned, platform)));
  const listed: string[] = [];
  for (const entry of [...own, ...stringEntries(workspaceValue), ...strays]) {
    if (!stopsFollowed(entry) && !listed.some((earlier) => samePath(earlier, entry, platform))) listed.push(entry);
  }
  // A workspace array replaces the user's own list, so it is written whole, and not at all when it would only repeat that list.
  return JSON.stringify(listed) === JSON.stringify(own) ? undefined : listed;
}

export interface ScmGuardDeps {
  platform: NodeJS.Platform;
  getExtension: (id: string) => GitExtensionHandle | undefined;
  /** A fresh read each call: a configuration object is a snapshot. */
  config: () => GitConfig;
  /** The extension host's one writer queue, shared with every other configuration write. */
  queue: ConfigQueue;
  workspaceState: {
    get(key: string): unknown;
    update(key: string, value: unknown): Thenable<void>;
  };
  /** `[anchor, ...followed]` */
  folders: () => readonly GitUri[];
  isNavigator: () => boolean;
  onDidChangeWorkspaceFolders: (listener: () => void) => GitDisposable;
  /** Fires with the folder a `.git` entry was just created in; the binding aims it at the followed folder. */
  onDidCreateGitEntry: GitEvent<GitUri>;
  /** Ends the wait a rejected write left. */
  onDidChangeConfiguration: (listener: () => void) => GitDisposable;
  /** Ends the wait a dirty workspace file left; the binding filters to that file. */
  onDidSaveWorkspaceFile: (listener: () => void) => GitDisposable;
  /** The loop guard's clock, in milliseconds. */
  now: () => number;
  /** Runs `fn` in a later macrotask, past the dispatch of the current event. */
  defer: (fn: () => void) => void;
  /** Resolves when a bounded wait for Git's reopen after a toggle, or for a new `.git` to fill, has run out; the binding owns the interval. */
  settle: () => Promise<void>;
  realpath: (path: string) => Promise<string>;
  setContext: (key: string, value: boolean) => void;
  showErrorMessage: (message: string) => void;
  log: Logger;
}

export interface ScmGuard {
  /** Never rejects; follow must not wait on it. */
  activate(): Promise<void>;
  initRepository(followedFolder: GitUri): Promise<void>;
  dispose(): void;
}

/** Keeps Source Control to the followed space's repository: writes the workspace settings, lists strays in `git.ignoredRepositories`, and drops them with a `git.enabled` toggle that leaves no closed-list entry. */
export function createScmGuard(deps: ScmGuardDeps): ScmGuard {
  const { platform, config, queue, workspaceState, folders, isNavigator, now, log } = deps;
  const listeners: GitDisposable[] = [];
  let api: GitApi | undefined;
  // Bumped by each folder change: a pass that sees it move has worked for a space no longer showing.
  let generation = 0;
  let history: ToggleAttempt[] = [];
  let survived: string[] = [];
  // Every pass after a toggle sees the same hold, so its cause is logged once per space.
  const loggedHolds = new Set<string>();
  let busy = false;
  let rerun = false;
  // A write was rejected past its retries, and only a later event can end what made it fail.
  let pending = false;
  let unopened: GitUri | undefined;

  const guarded = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (err: unknown) {
      log("info", `scm: ${what}: ${errorText(err)}`);
    }
  };

  const writeSetting = (key: string, value: unknown): Promise<void> => queue.run(() => config().update(key, value), WRITE_RETRIES);

  // Reads inside the queue, since a list read ahead of an earlier queued write would undo that write.
  const syncIgnored = (owned: string | null, strays: readonly string[]): Promise<void> =>
    queue.run(() => {
      const current = config();
      const { globalValue, workspaceValue } = current.inspect(IGNORED_KEY) ?? {};
      const next = nextIgnoredList({ globalValue, workspaceValue, owned, strays, followed: folders()[1]?.fsPath, platform });
      if (JSON.stringify(next) === JSON.stringify(workspaceValue)) return Promise.resolve();
      return current.update(IGNORED_KEY, next);
    }, WRITE_RETRIES);

  // A false left in the file disables Git at the next start, and only the removal brings its model back.
  const recoverToggle = async (): Promise<void> => {
    if (workspaceState.get(TOGGLE_RECORD_KEY) === undefined) return;
    if (config().inspect("enabled")?.workspaceValue === false) {
      await writeSetting("enabled", undefined);
      log("info", "scm: removed the git.enabled false an interrupted toggle left behind");
    }
    await workspaceState.update(TOGGLE_RECORD_KEY, undefined);
  };

  const ensureSettings = async (): Promise<void> => {
    if (!isNavigator()) return;
    for (const [fullKey, value] of Object.entries(NAVIGATOR_GIT_SETTINGS)) {
      const key = fullKey.slice("git.".length);
      if (config().inspect(key)?.workspaceValue !== value) await writeSetting(key, value);
    }
  };

  const refreshOffer = (): void => {
    const paths = isNavigator() ? folders().map(({ fsPath }) => fsPath) : [];
    deps.setContext(INIT_OFFER_KEY, initOffer(paths, api !== undefined));
  };

  // The toggle disposes by `git.enabled` and needs no real path, so a path that cannot resolve must not keep anything open.
  const realPath = async (path: string): Promise<string> => {
    try {
      return await deps.realpath(path);
    } catch (err: unknown) {
      log("info", `scm: no real path for ${path}, comparing it as written: ${errorText(err)}`);
      return path;
    }
  };

  // A Git root can be canonical while a folder is a symlink, junction or mapped drive, so a string stray is confirmed on real paths. The result keeps Git's spelling, which is what `git.ignoredRepositories` compares.
  const decide = async (roots: readonly string[]): Promise<ScmDecision> => {
    const paths = folders().map(({ fsPath }) => fsPath);
    const byString = decideScm({ folders: paths, roots, platform });
    if (byString.strays.length === 0) return byString;
    // Only the followed folder and the roots decide, so the anchor and an added folder are not asked about.
    const realFolders = await Promise.all(paths.map((path, index) => (index === 1 ? realPath(path) : path)));
    const resolved = await Promise.all(roots.map(async (root) => ({ root, real: await realPath(root) })));
    const { owned } = decideScm({ folders: realFolders, roots: resolved.map(({ real }) => real), platform });
    return {
      owned: resolved.find(({ real }) => real === owned)?.root ?? null,
      strays: resolved.filter(({ real }) => real !== owned).map(({ root }) => root),
    };
  };

  // `update` resolves before Git's reopen finishes, so the open event is what ends the wait, and a followed folder with no repository ends it by the bound.
  const followedReopened = (git: GitApi): Promise<void> =>
    new Promise((resolve) => {
      const followed = folders()[1]?.fsPath;
      const opened = git.onDidOpenRepository(({ rootUri }) => {
        if (isSameOrInside(followed, rootUri.fsPath, platform)) finish();
      });
      const finish = (): void => {
        opened.dispose();
        resolve();
      };
      void deps.settle().then(finish);
    });

  const toggle = async (git: GitApi, strays: readonly string[], dropping: readonly string[], stale: () => boolean): Promise<void> => {
    await workspaceState.update(TOGGLE_RECORD_KEY, "in-flight");
    try {
      await writeSetting("enabled", false);
    } catch (err: unknown) {
      await workspaceState.update(TOGGLE_RECORD_KEY, undefined);
      throw err;
    }
    // The false is in the file either way, so a stale pass only skips the guard's record and still removes it.
    if (!stale()) {
      const at = now();
      history = [...history, ...dropping.map((root) => ({ root, at }))];
      // The false write disposes before it resolves, so a stray still listed here was never disposed.
      survived = strays.filter((stray) => git.repositories.some(({ rootUri }) => samePath(rootUri.fsPath, stray, platform)));
    }
    const reopened = followedReopened(git);
    try {
      await writeSetting("enabled", undefined);
    } catch (err: unknown) {
      // The record stays: the next pass's recovery removes the false.
      pending = true;
      log("warn", `scm: Git stays off in this window until a later event retries it, git.enabled false could not be removed: ${errorText(err)}`);
      return;
    }
    await workspaceState.update(TOGGLE_RECORD_KEY, undefined);
    await reopened;
  };

  const reconcile = async (git: GitApi): Promise<void> => {
    if (!isNavigator()) return;
    await recoverToggle();
    // The scan's opens are covered by the pass that `initialized` triggers.
    if (git.state !== "initialized") return;
    const started = generation;
    const stale = (): boolean => {
      if (generation === started) return false;
      rerun = true;
      return true;
    };
    const decision = await decide(git.repositories.map(({ rootUri }) => rootUri.fsPath));
    if (stale()) return;
    // Every pass, not only a dropping one, as a newly followed root's old entry must go before anything can open it.
    await syncIgnored(decision.owned, decision.strays);
    if (stale()) return;
    const { toggle: dropping, hold } = guardToggles({ strays: decision.strays, history, survived, now, platform });
    for (const { root, reason } of hold) {
      const key = `${reason} ${root}`;
      if (loggedHolds.has(key)) continue;
      loggedHolds.add(key);
      log("info", `scm: left open ${root}: ${HOLD_CAUSE[reason]}`);
    }
    if (dropping.length === 0) return;
    log("info", `scm: dropping ${dropping.join(", ")}`);
    await toggle(git, decision.strays, dropping, stale);
  };

  // `git.autoRepositoryDetection: false` turns off Git's own `.git` watcher, so nothing else opens what the followed folder gains.
  const openFollowed = async (git: GitApi, folder: GitUri, retryLater: boolean): Promise<void> => {
    if (!isNavigator() || !samePath(folders()[1]?.fsPath, folder.fsPath, platform)) return;
    if (git.repositories.some(({ rootUri }) => isSameOrInside(folder.fsPath, rootUri.fsPath, platform))) return;
    // A listed root opens nothing and says nothing, so its entry goes first.
    await syncIgnored(null, []);
    if ((await git.openRepository(folder)) !== null) return;
    log("info", `scm: ${folder.fsPath} gained a .git but Git opened no repository there`);
    if (retryLater) unopened = folder;
  };

  // `git init` creates `.git` before it is a repository, hence the wait, which Git's own path has too.
  const openGained = async (git: GitApi, folder: GitUri): Promise<void> => {
    await deps.settle();
    await openFollowed(git, folder, true);
  };

  // A `git init` slower than the wait leaves no event of its own, so the next one gets one more try and no loop.
  const retryUnopened = async (git: GitApi): Promise<void> => {
    if (unopened === undefined) return;
    const folder = unopened;
    unopened = undefined;
    await guarded("could not open the followed folder's new repository", () => openFollowed(git, folder, false));
  };

  // One pass at a time: a trigger during a pass or its reopen wait runs one more pass after it.
  const trigger = async (git: GitApi): Promise<void> => {
    if (busy) {
      rerun = true;
      return;
    }
    busy = true;
    do {
      rerun = false;
      pending = false;
      try {
        await reconcile(git);
      } catch (err: unknown) {
        pending = true;
        log("info", `scm: reconcile stopped, a later event retries it: ${errorText(err)}`);
      }
    } while (rerun);
    busy = false;
    await retryUnopened(git);
  };

  const start = async (extension: GitExtensionExports): Promise<void> => {
    const git = extension.getAPI(1);
    api = git;
    refreshOffer();
    listeners.push(
      git.onDidOpenRepository(() => void trigger(git)),
      git.onDidChangeState((state) => {
        if (state === "initialized") void trigger(git);
      }),
      // Git's own disposal of removed folders runs synchronously in this event, so only a later look shows what it kept.
      deps.onDidChangeWorkspaceFolders(() => {
        generation++;
        history = [];
        survived = [];
        loggedHolds.clear();
        refreshOffer();
        deps.defer(() => void trigger(git));
      }),
      deps.onDidCreateGitEntry((folder) => void guarded("could not open the followed folder's new repository", () => openGained(git, folder))),
    );
    // Busy too: a save during a write's last attempt comes before that attempt's rejection sets `pending`.
    const retryRejected = (): void => {
      if (pending || busy) void trigger(git);
    };
    listeners.push(deps.onDidChangeConfiguration(retryRejected), deps.onDidSaveWorkspaceFile(retryRejected));
    await guarded("could not write the Git settings", ensureSettings);
    await trigger(git);
  };

  const connect = async (): Promise<void> => {
    const handle = deps.getExtension(GIT_EXTENSION_ID);
    if (handle === undefined) {
      log("info", "scm: the Git extension is absent or disabled, nothing to do");
      return;
    }
    const extension = await handle.activate();
    if (extension === undefined) {
      log("info", "scm: the Git extension exports nothing, nothing to do");
      return;
    }
    if (extension.enabled) return start(extension);
    log("info", "scm: Git has no model yet, waiting for it");
    const waiting = extension.onDidChangeEnablement((enabled) => {
      if (!enabled) return;
      waiting.dispose();
      void guarded("Git is unavailable", () => start(extension));
    });
    listeners.push(waiting);
  };

  const recover = (): Promise<void> => guarded("could not remove the git.enabled false an interrupted toggle left behind", recoverToggle);

  return {
    activate: async () => {
      // With the false in the file Git has no model, so none of its events can retry a rejected removal; once it has one, each pass recovers first.
      const recoverWithoutModel = (): void => {
        if (api === undefined) void recover();
      };
      listeners.push(deps.onDidChangeConfiguration(recoverWithoutModel), deps.onDidSaveWorkspaceFile(recoverWithoutModel));
      await recover();
      await guarded("Git is unavailable", connect);
    },
    initRepository: async (followedFolder) => {
      if (api === undefined) {
        deps.showErrorMessage("Herdr Navigator: Git is not available.");
        return;
      }
      try {
        const { owned } = decideScm({ folders: folders().map(({ fsPath }) => fsPath), roots: api.repositories.map(({ rootUri }) => rootUri.fsPath), platform });
        // A listed root opens nothing and says nothing, so its entry goes first.
        await syncIgnored(owned, []);
        const defaultBranch = config().get("defaultBranchName");
        const repository = await api.init(followedFolder, typeof defaultBranch === "string" && defaultBranch !== "" ? { defaultBranch } : undefined);
        // Init can return null or an enclosing repository while the new root stays unopened.
        if (repository === null || !samePath(repository.rootUri.fsPath, followedFolder.fsPath, platform)) await api.openRepository(followedFolder);
      } catch (err: unknown) {
        deps.showErrorMessage(`Herdr Navigator: could not initialize a repository: ${errorText(err)}`);
      }
    },
    dispose: () => {
      for (const listener of listeners) listener.dispose();
    },
  };
}
