import { NAVIGATOR_WORKSPACE_SETTINGS } from "../follow/planFolders";
import type { Logger } from "../herdr";
import { errorText } from "../log";
import { isSameOrInside, samePath } from "../paths";
import { decideAnchorGit, decideScm, guardToggles, initialBranch } from "../scm/decision";
import type { GitDirLook, ScmDecision, ScmHoldReason, ToggleAttempt } from "../scm/decision";
import type { ConfigQueue } from "./configQueue";

const GIT_EXTENSION_ID = "vscode.git";
const GIT_SECTION = "git";
const TOGGLE_RECORD_KEY = "herdrNavigator.gitEnabledToggle";
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
  openRepository(root: GitUri): Thenable<GitRepository | null>;
  init(root: GitUri, options?: { defaultBranch?: string }): Thenable<GitRepository | null>;
}

export interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: GitEvent<boolean>;
  getAPI(version: 1): GitApi;
}

export interface GitExtensionHandle {
  activate(): Thenable<GitExtensionExports | undefined>;
}

/** One configuration section; `update` writes at Workspace scope only, a target the VS Code binding owns. */
export interface SectionConfig {
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
  config: (section: string) => SectionConfig;
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
  /** Fires when a `.git` entry was just created in the anchor, `folders()[0]`. */
  onDidCreateAnchorGitEntry: (listener: () => void) => GitDisposable;
  /** A look at `<folder>/.git`; undefined when no entry is there. */
  readGitDir: (folder: string) => Promise<GitDirLook | undefined>;
  /** Removes `<folder>/.git` recursively. */
  removeGitDir: (folder: string) => Promise<void>;
  hasGitEntry: (folder: string) => Promise<boolean>;
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
  /** Resolves when the most a switch may wait for its repository has run out; the binding owns the interval. */
  openFirstBound: () => Promise<void>;
  /** The nearest ancestor of `path`, itself included, holding a `.git` entry, as the URI Git's API needs; undefined when none does. */
  repositoryRootOf: (path: string) => Promise<GitUri | undefined>;
  realpath: (path: string) => Promise<string>;
  log: Logger;
}

export interface ScmGuard {
  /** Never rejects; follow must not wait on it. */
  activate(): Promise<void>;
  /**
   * Opens the target's repository ahead of the folder swap, so the view never reaches no repository. Never rejects.
   * Resolves at once with no `.git` at or above the target or when `isCurrent()` is already false, otherwise when the open settles or the bound runs out; a started open must be followed by the swap, since only that removes it without a toggle.
   */
  prepareSwitch(targetPath: string, isCurrent: () => boolean): Promise<void>;
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
  // The root opened ahead of its swap, until the next folder change: from there the followed-folder rule owns it, and any root opening later must drop like any stray.
  let incoming: string | undefined;
  // Bumped by each anchor `.git` event: only the last one's wait goes on to look.
  let anchorGitEvents = 0;

  const guarded = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (err: unknown) {
      log("info", `scm: ${what}: ${errorText(err)}`);
    }
  };

  const writeSetting = (key: string, value: unknown, section = GIT_SECTION): Promise<void> => queue.run(() => config(section).update(key, value), WRITE_RETRIES);

  // Reads inside the queue, since a list read ahead of an earlier queued write would undo that write.
  const syncIgnored = (owned: string | null, strays: readonly string[], followed?: string): Promise<void> =>
    queue.run(() => {
      const current = config(GIT_SECTION);
      const { globalValue, workspaceValue } = current.inspect(IGNORED_KEY) ?? {};
      const next = nextIgnoredList({ globalValue, workspaceValue, owned, strays, followed: followed ?? folders()[1]?.fsPath, platform });
      if (JSON.stringify(next) === JSON.stringify(workspaceValue)) return Promise.resolve();
      return current.update(IGNORED_KEY, next);
    }, WRITE_RETRIES);

  // A false left in the file disables Git at the next start, and only the removal brings its model back.
  const recoverToggle = async (): Promise<void> => {
    if (workspaceState.get(TOGGLE_RECORD_KEY) === undefined) return;
    if (config(GIT_SECTION).inspect("enabled")?.workspaceValue === false) {
      await writeSetting("enabled", undefined);
      log("info", "scm: removed the git.enabled false an interrupted toggle left behind");
    }
    await workspaceState.update(TOGGLE_RECORD_KEY, undefined);
  };

  const ensureSettings = async (): Promise<void> => {
    if (!isNavigator()) return;
    for (const [fullKey, value] of Object.entries(NAVIGATOR_WORKSPACE_SETTINGS)) {
      const dot = fullKey.indexOf(".");
      const section = fullKey.slice(0, dot);
      const key = fullKey.slice(dot + 1);
      if (config(section).inspect(key)?.workspaceValue !== value) await writeSetting(key, value, section);
    }
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
    const opening = incoming;
    const byString = decideScm({ folders: paths, roots, incoming: opening, platform });
    if (byString.strays.length === 0) return byString;
    // Only the followed folder and the roots decide, so the anchor and an added folder are not asked about.
    const realFolders = await Promise.all(paths.map((path, index) => (index === 1 ? realPath(path) : path)));
    const realIncoming = opening === undefined ? undefined : await realPath(opening);
    const resolved = await Promise.all(roots.map(async (root) => ({ root, real: await realPath(root) })));
    const { owned, strays } = decideScm({ folders: realFolders, roots: resolved.map(({ real }) => real), incoming: realIncoming, platform });
    return {
      owned: resolved.find(({ real }) => real === owned)?.root ?? null,
      strays: resolved.filter(({ real }) => strays.includes(real)).map(({ root }) => root),
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

  const openFirst = async (git: GitApi, targetPath: string, isCurrent: () => boolean): Promise<void> => {
    const root = await deps.repositoryRootOf(targetPath);
    // `openRepository` has no cancellation, so this is the last point a newer focus can stop one.
    if (root === undefined || !isCurrent()) return;
    const { fsPath } = root;
    incoming = fsPath;
    const opening = guarded(`could not open ${fsPath} ahead of the switch`, async () => {
      // A listed root opens nothing and says nothing, so its entry goes first.
      await syncIgnored(fsPath, [], targetPath);
      // A swap that went ahead past the bound leaves this open to Git, and it could land on a space already left.
      if (incoming !== fsPath) return;
      if ((await git.openRepository(root)) === null) log("info", `scm: Git opened no repository at ${fsPath} ahead of the switch`);
    });
    const settled = await Promise.race([opening.then(() => true), deps.openFirstBound().then(() => false)]);
    if (!settled) log("info", `scm: ${fsPath} is still opening past the bound, the switch goes on`);
  };

  // A `git init` still writing can hold a file open, so a failed removal gets one more try past another wait.
  const removeAnchorGit = async (anchor: string): Promise<void> => {
    try {
      await deps.removeGitDir(anchor);
    } catch (err: unknown) {
      log("info", `scm: trying once more to remove the .git in ${anchor}: ${errorText(err)}`);
      await deps.settle();
      await deps.removeGitDir(anchor);
    }
  };

  // No pick is in hand at activation, so a fresh `.git` an earlier build left goes with nothing initialised in its place.
  const clearStaleAnchorGit = async (): Promise<void> => {
    const anchor = folders()[0]?.fsPath;
    if (anchor === undefined || !isNavigator()) return;
    const look = await deps.readGitDir(anchor);
    if (look === undefined) return;
    if (decideAnchorGit({ look }) === "leave") {
      log("info", `scm: left the .git in the anchor ${anchor} alone, it is more than a fresh git init`);
      return;
    }
    await removeAnchorGit(anchor);
    log("info", `scm: cleared the fresh .git an earlier build left in the anchor ${anchor}`);
  };

  // Git's Initialize pick selects the anchor by default, and the anchor's `git.enabled: false` means Git never opens what lands there, so Enter would otherwise do nothing the user can see.
  const redirectAnchorInit = async (git: GitApi): Promise<void> => {
    const event = ++anchorGitEvents;
    const started = generation;
    await deps.settle();
    if (event !== anchorGitEvents) return;
    const [anchor, followed] = folders();
    if (anchor === undefined || !isNavigator()) return;
    const look = await deps.readGitDir(anchor.fsPath);
    if (look === undefined) return;
    const action = decideAnchorGit({ look, followedHasGit: followed === undefined ? undefined : await deps.hasGitEntry(followed.fsPath) });
    if (action === "leave") {
      log("info", `scm: left the .git in the anchor ${anchor.fsPath} alone, it is more than a fresh git init`);
      return;
    }
    await removeAnchorGit(anchor.fsPath);
    log("info", `scm: removed the fresh .git Git's Initialize pick put in the anchor ${anchor.fsPath}`);
    if (action === "remove" || followed === undefined) return;
    // The pick was for the space showing then; a `git init` in one the user only just moved to is not what they chose.
    if (generation !== started) {
      log("info", `scm: not initialising ${followed.fsPath}, the space changed after the pick`);
      return;
    }
    if (action === "remove-and-open") {
      await openFollowed(git, followed, true);
      return;
    }
    // A listed root opens nothing and says nothing, so its entry goes first.
    await syncIgnored(null, []);
    // `API.init` reads no setting, so this is what keeps both picks of the button on one branch.
    const settings = config(GIT_SECTION);
    const defaultBranch = initialBranch(settings.get("defaultBranchName"), settings.get("branchWhitespaceChar"));
    if ((await git.init(followed, { defaultBranch })) === null) log("info", `scm: Git opened no repository at ${followed.fsPath} after initialising it`);
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
    listeners.push(
      git.onDidOpenRepository(() => void trigger(git)),
      git.onDidChangeState((state) => {
        if (state === "initialized") void trigger(git);
      }),
      // Git's own disposal of removed folders runs synchronously in this event, so only a later look shows what it kept.
      deps.onDidChangeWorkspaceFolders(() => {
        generation++;
        // Here and not in the deferred pass, which could otherwise end the mark of a switch started since.
        incoming = undefined;
        history = [];
        survived = [];
        loggedHolds.clear();
        deps.defer(() => void trigger(git));
      }),
      deps.onDidCreateGitEntry((folder) => void guarded("could not open the followed folder's new repository", () => openGained(git, folder))),
      deps.onDidCreateAnchorGitEntry(() => void guarded("could not hand Git's Initialize pick on to the followed folder", () => redirectAnchorInit(git))),
    );
    // Busy too: a save during a write's last attempt comes before that attempt's rejection sets `pending`.
    const retryRejected = (): void => {
      if (pending || busy) void trigger(git);
    };
    listeners.push(deps.onDidChangeConfiguration(retryRejected), deps.onDidSaveWorkspaceFile(retryRejected));
    await guarded("could not write the workspace settings", ensureSettings);
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
      await guarded("could not clear the anchor's fresh .git", clearStaleAnchorGit);
      await guarded("Git is unavailable", connect);
    },
    prepareSwitch: (targetPath, isCurrent) =>
      guarded("could not open the next space's repository first", async () => {
        if (api !== undefined && isNavigator()) await openFirst(api, targetPath, isCurrent);
      }),
    dispose: () => {
      for (const listener of listeners) listener.dispose();
    },
  };
}
