import assert from "node:assert/strict";
import { NAVIGATOR_WORKSPACE_SETTINGS } from "../../../follow/planFolders";
import type { GitDirLook } from "../../../scm/decision";
import { createConfigQueue } from "../../../vscode/configQueue";
import { createScmGuard } from "../../../vscode/scmGuard";
import type { GitApi, GitDisposable, GitEvent, GitExtensionExports, GitRepository, GitUri, ScmGuardDeps } from "../../../vscode/scmGuard";

const ANCHOR = "C:\\Users\\me\\anchor";
const PARENT = "C:\\Users\\me\\Projects\\parentdir";
const NESTED = "C:\\Users\\me\\Projects\\parentdir\\nestedrepo";
const REPO_A = "C:\\Users\\me\\Projects\\repoA";
const REPO_B = "C:\\Users\\me\\Projects\\repoB";

const uri = (fsPath: string): GitUri => ({ fsPath });
const repo = (fsPath: string): GitRepository => ({ rootUri: uri(fsPath) });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
};

function emitter<T>(): { event: GitEvent<T>; fire: (value: T) => void; count: () => number } {
  const listeners = new Set<(value: T) => void>();
  const event: GitEvent<T> = (listener): GitDisposable => {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  };
  return { event, fire: (value) => [...listeners].forEach((listener) => listener(value)), count: () => listeners.size };
}

interface Options {
  followed?: string[];
  roots?: string[];
  state?: GitApi["state"];
  settings?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  /** Folder roots holding a repository, which Git reopens on a configuration change unless listed. */
  repos?: string[];
  /** Roots a false write does not dispose, as their own folder sets `git.enabled: true`. */
  survivors?: string[];
  record?: string;
  navigator?: boolean;
  extension?: "missing" | "disabled" | "throws" | "live";
  realpath?: ScmGuardDeps["realpath"];
  updateFails?: (key: string, value: unknown) => boolean;
  open?: () => Promise<GitRepository | null>;
  holdSettle?: boolean;
  /** The target's repository root; the target itself by default, as `followGitRoot` leaves most targets. */
  rootOf?: ScmGuardDeps["repositoryRootOf"];
  /** The anchor's `.git`, none by default. */
  anchorGit?: GitDirLook;
  followedHasGit?: boolean;
  init?: () => Promise<GitRepository | null>;
  /** How many removals fail before one works. */
  removeFailures?: number;
}

/** Git's keys are stored bare, as most assertions read them; any other section stays in the key, so a write under the wrong section shows. */
const storedKey = (section: string, key: string): string => (section === "git" ? key : `${section}.${key}`);

/** The settings as `inspect` sees them, so a setup with no override has nothing left to ensure. */
const NAVIGATOR_SETTINGS_BY_KEY = Object.fromEntries(Object.entries(NAVIGATOR_WORKSPACE_SETTINGS).map(([key, value]) => [key.replace(/^git\./, ""), value]));

function setup(options: Options = {}) {
  const settings: Record<string, unknown> = { ...NAVIGATOR_SETTINGS_BY_KEY, ...options.settings };
  const roots = { list: options.roots ?? [] };
  const opened = emitter<GitRepository>();
  const stateChange = emitter<GitApi["state"]>();
  const enablement = emitter<boolean>();
  const folderChange = emitter<void>();
  const gitEntry = emitter<GitUri>();
  const anchorEntry = emitter<void>();
  const configChange = emitter<void>();
  const saved = emitter<void>();
  const clock = { now: 0 };
  const deferred: Array<() => void> = [];
  const settles: Array<() => void> = [];
  const bounds: Array<() => void> = [];
  const events: string[] = [];
  const logs: string[] = [];
  const openCalls: string[] = [];
  const inits: unknown[] = [];
  const state = {
    record: options.record as unknown,
    folders: [ANCHOR, ...(options.followed ?? [])],
    gitState: options.state ?? "initialized",
    navigator: options.navigator ?? true,
    anchorGit: options.anchorGit,
    removeFailures: options.removeFailures ?? 0,
  };

  const api: GitApi = {
    get state() {
      return state.gitState;
    },
    onDidChangeState: stateChange.event,
    get repositories() {
      return roots.list.map(repo);
    },
    onDidOpenRepository: opened.event,
    openRepository: async (root) => {
      openCalls.push(root.fsPath);
      events.push("open");
      return options.open ? options.open() : repo(root.fsPath);
    },
    init: async (root, initOptions) => {
      events.push(`init ${root.fsPath}`);
      inits.push(initOptions);
      return options.init ? options.init() : repo(root.fsPath);
    },
  };
  // As measured: the false disposes every root its own folder does not keep on, and any later configuration change reopens the folder roots not listed.
  const applyToGit = (key: string, value: unknown): void => {
    if (key === "enabled" && value === false) roots.list = roots.list.filter((root) => options.survivors?.includes(root));
    if (settings["enabled"] === false) return;
    const ignored: unknown = settings["ignoredRepositories"];
    const reopened = state.folders.filter((folder) => options.repos?.includes(folder) && !(Array.isArray(ignored) && ignored.includes(folder)) && !roots.list.includes(folder));
    roots.list = [...roots.list, ...reopened];
  };
  const extension: GitExtensionExports = {
    enabled: options.extension !== "disabled",
    onDidChangeEnablement: enablement.event,
    getAPI: () => {
      if (options.extension === "throws") throw new Error("Git model not found");
      return api;
    },
  };

  const deps: ScmGuardDeps = {
    platform: "win32",
    getExtension: () => (options.extension === "missing" ? undefined : { activate: async () => extension }),
    config: (section) => ({
      get: (key) => settings[storedKey(section, key)] ?? options.globals?.[storedKey(section, key)],
      inspect: (key) => ({ workspaceValue: settings[storedKey(section, key)], globalValue: options.globals?.[storedKey(section, key)] }),
      update: async (key, value) => {
        const stored = storedKey(section, key);
        if (options.updateFails?.(stored, value)) throw new Error("file is dirty");
        events.push(`update ${stored}=${String(value)}`);
        settings[stored] = value;
        applyToGit(stored, value);
      },
    }),
    queue: createConfigQueue({ delay: async () => undefined }),
    workspaceState: {
      get: () => state.record,
      update: async (_key, value) => {
        events.push(`record ${String(value)}`);
        state.record = value;
      },
    },
    folders: () => state.folders.map(uri),
    isNavigator: () => state.navigator,
    onDidChangeWorkspaceFolders: (listener) => folderChange.event(listener),
    onDidCreateGitEntry: gitEntry.event,
    onDidCreateAnchorGitEntry: (listener) => anchorEntry.event(listener),
    readGitDir: async () => state.anchorGit,
    removeGitDir: async (folder) => {
      if (state.removeFailures > 0) {
        state.removeFailures--;
        throw new Error("EBUSY");
      }
      events.push(`remove ${folder}`);
      state.anchorGit = undefined;
    },
    hasGitEntry: async () => options.followedHasGit ?? false,
    onDidChangeConfiguration: (listener) => configChange.event(listener),
    onDidSaveWorkspaceFile: (listener) => saved.event(listener),
    now: () => clock.now,
    defer: (fn) => void deferred.push(fn),
    settle: () => (options.holdSettle ? new Promise((resolve) => settles.push(resolve)) : Promise.resolve()),
    openFirstBound: () => new Promise((resolve) => bounds.push(resolve)),
    repositoryRootOf: options.rootOf ?? (async (path) => uri(path)),
    realpath: options.realpath ?? (async (path) => path),
    log: (_level, message) => void logs.push(message),
  };

  const runDeferred = (): void => {
    for (const fn of deferred.splice(0)) fn();
  };
  const runSettles = (): void => {
    for (const resolve of settles.splice(0)) resolve();
  };
  return { guard: createScmGuard(deps), roots, opened, stateChange, enablement, folderChange, gitEntry, anchorEntry, configChange, saved, clock, deferred, runDeferred, settles, runSettles, bounds, events, logs, openCalls, inits, state, settings };
}

const FULL_TOGGLE = ["record in-flight", "update enabled=false", "update enabled=undefined", "record undefined"];
const listed = (...entries: string[]): string => `update ignoredRepositories=${entries.join(",")}`;
const UNLISTED = "update ignoredRepositories=undefined";

describe("createScmGuard", () => {
  it("stays a logged no-op when Git is unavailable, writes only the settings that differ, and leaves a plain window alone", async () => {
    // No Git to work with: follow goes on, nothing is written, and each cause says why once.
    for (const extension of ["missing", "throws"] as const) {
      const unavailable = setup({ extension, followed: [REPO_A], settings: { autoRepositoryDetection: undefined } });
      await unavailable.guard.activate();
      assert.deepEqual(unavailable.events, []);
      assert.equal(unavailable.logs.length, 1, extension);
    }

    // A disabled Git is waited for, not retried; the settings go in only once a model exists.
    const late = setup({ extension: "disabled", followed: [REPO_A], settings: { detectSubmodules: undefined } });
    await late.guard.activate();
    assert.equal(late.logs.length, 1);
    assert.deepEqual(late.events, []);
    late.enablement.fire(true);
    await flush();
    assert.deepEqual(late.events, ["update detectSubmodules=false"]);

    // Settings: only what differs is written, each through its own section, so an existing workspace file gains the single selection Changes relies on; a reject costs one log line and no follow failure.
    const fresh = setup({ followed: [REPO_A], settings: { autoRepositoryDetection: true, openRepositoryInParentFolders: undefined, "scm.repositories.selectionMode": undefined } });
    await fresh.guard.activate();
    assert.deepEqual(fresh.events, ["update autoRepositoryDetection=false", "update openRepositoryInParentFolders=always", "update scm.repositories.selectionMode=single"]);
    const rejected = setup({ followed: [REPO_A], settings: { detectWorktrees: undefined }, updateFails: () => true });
    await rejected.guard.activate();
    assert.deepEqual(rejected.events, []);
    assert.equal(rejected.logs.length, 1);

    // A plain window is none of this module's business: no settings, no toggle.
    const plain = setup({ navigator: false, followed: [REPO_A], roots: [REPO_B], settings: { detectSubmodules: undefined } });
    await plain.guard.activate();
    assert.deepEqual(plain.events, []);
  });

  it("drops every repository but the followed space's, holds what it cannot drop without looping, compares roots by real path, and leaves no Git listener after dispose", async () => {
    // Switching away from repoA with an editor open keeps its root listed: dropped one macrotask later, record around both writes.
    const retained = setup({ followed: [REPO_A], roots: [REPO_A], holdSettle: true });
    await retained.guard.activate();
    assert.deepEqual(retained.events, []);
    retained.state.folders = [ANCHOR, REPO_B];
    retained.roots.list = [REPO_A, REPO_B];
    retained.folderChange.fire();
    await flush();
    assert.deepEqual(retained.events, [], "Git's own disposal has not run yet inside the event");
    assert.equal(retained.deferred.length, 1);
    retained.runDeferred();
    await flush();
    assert.deepEqual(retained.events, [listed(REPO_A), ...FULL_TOGGLE]);

    // The followed root's reopen ends the wait with the bound still running; the extra pass finds only that root, and rewrites nothing as the list reads the same.
    assert.equal(retained.opened.count(), 2);
    retained.roots.list = [REPO_B];
    retained.opened.fire(repo(REPO_B));
    await flush();
    assert.deepEqual(retained.events, [listed(REPO_A), ...FULL_TOGGLE]);
    assert.equal(retained.opened.count(), 1, "the wait's own listener is gone, only the guard's stays");

    // A nested repository of a non-repository space is dropped as soon as it opens.
    const nested = setup({ followed: [PARENT], roots: [], holdSettle: true });
    await nested.guard.activate();
    nested.roots.list = [NESTED];
    nested.opened.fire(repo(NESTED));
    await flush();
    assert.deepEqual(nested.events, [listed(NESTED), ...FULL_TOGGLE]);
    // parentdir has no repository, so only the bound ends this wait.
    assert.equal(nested.opened.count(), 2);
    nested.runSettles();
    await flush();
    assert.equal(nested.opened.count(), 1);

    // A reopen long after the toggle settled is no loop, so it is dropped again in the same space, with the list already right.
    nested.clock.now = 60_000;
    nested.roots.list = [NESTED];
    nested.opened.fire(repo(NESTED));
    await flush();
    nested.runSettles();
    await flush();
    assert.deepEqual(nested.events, [listed(NESTED), ...FULL_TOGGLE, ...FULL_TOGGLE]);

    // A folder root goes the same way: listed before the removal write, or that write would bring it straight back.
    const anchorRoot = setup({ followed: [REPO_A], roots: [ANCHOR, REPO_A], repos: [ANCHOR, REPO_A] });
    await anchorRoot.guard.activate();
    assert.deepEqual(anchorRoot.events, [listed(ANCHOR), ...FULL_TOGGLE]);
    assert.deepEqual(anchorRoot.roots.list, [REPO_A]);

    // A parent repository above the followed one is a stray too: only the selected space's own root stays.
    const parentRoot = setup({ followed: [NESTED], roots: [PARENT, NESTED] });
    await parentRoot.guard.activate();
    assert.deepEqual(parentRoot.events, [listed(PARENT), ...FULL_TOGGLE]);

    // The user's own list is hidden by any workspace array, so it is written along; with nothing added, no workspace value is needed.
    const MINE = "C:\\Users\\me\\Projects\\mine";
    const ownList = setup({ followed: [REPO_A], roots: [REPO_A, NESTED], globals: { ignoredRepositories: [MINE] } });
    await ownList.guard.activate();
    assert.deepEqual(ownList.events, [listed(MINE, NESTED), ...FULL_TOGGLE]);
    const ownListOnly = setup({ followed: [REPO_A], roots: [REPO_A], globals: { ignoredRepositories: [MINE] } });
    await ownListOnly.guard.activate();
    assert.deepEqual(ownListOnly.events, []);

    // Returning to a space lifts its entry, or Git would never show the selected repository; another space's entry stays.
    const back = setup({ followed: [REPO_A], roots: [], repos: [REPO_A, REPO_B], settings: { ignoredRepositories: [REPO_A, REPO_B] } });
    await back.guard.activate();
    assert.deepEqual(back.events, [listed(REPO_B)]);
    assert.deepEqual(back.roots.list, [REPO_A]);
    const onlyEntry = setup({ followed: [`${PARENT}\\sub`], settings: { ignoredRepositories: [PARENT, `${PARENT}\\sub`] } });
    await onlyEntry.guard.activate();
    assert.deepEqual(onlyEntry.events, [UNLISTED], "an entry at or above the followed folder would stop its repository too");
    const deeperStray = setup({ followed: [`${NESTED}\\sub`], roots: [NESTED], settings: { ignoredRepositories: [PARENT] } });
    await deeperStray.guard.activate();
    assert.deepEqual(deeperStray.events, [], "an entry above the open owned root stops nothing the followed folder needs");

    // Mid-scan opens wait for the scan to end, then one pass handles them all.
    const scanning = setup({ state: "uninitialized", followed: [PARENT], roots: [NESTED] });
    await scanning.guard.activate();
    assert.deepEqual(scanning.events, []);
    scanning.state.gitState = "initialized";
    scanning.stateChange.fire("initialized");
    await flush();
    assert.deepEqual(scanning.events, [listed(NESTED), ...FULL_TOGGLE]);

    // A root Git never disposed cannot be dropped by another toggle, so it is held with its cause, said once per space however many passes see it, and a new space releases it.
    const survivor = setup({ followed: [REPO_A], roots: [REPO_A, NESTED], survivors: [NESTED] });
    const holdLines = (): number => survivor.logs.filter((line) => line === `scm: left open ${NESTED}: it outlived the git.enabled false, so its own folder's settings keep Git on there`).length;
    await survivor.guard.activate();
    assert.deepEqual(survivor.events, [listed(NESTED), ...FULL_TOGGLE]);
    survivor.opened.fire(repo(REPO_A));
    await flush();
    survivor.opened.fire(repo(REPO_A));
    await flush();
    assert.deepEqual(survivor.events, [listed(NESTED), ...FULL_TOGGLE]);
    assert.equal(holdLines(), 1);
    survivor.roots.list = [REPO_B, NESTED];
    survivor.state.folders = [ANCHOR, REPO_B];
    survivor.folderChange.fire();
    survivor.runDeferred();
    await flush();
    assert.deepEqual(survivor.events, [listed(NESTED), ...FULL_TOGGLE, ...FULL_TOGGLE]);
    survivor.opened.fire(repo(REPO_B));
    await flush();
    assert.equal(holdLines(), 2);

    // Only Git undoing the toggle again and again is held: a fifth toggle inside the window does not run, and the quiet period gives the next open a drop.
    const looping = setup({ followed: [REPO_A], roots: [REPO_A, NESTED] });
    await looping.guard.activate();
    for (let reopen = 0; reopen < 4; reopen++) {
      looping.roots.list = [REPO_A, NESTED];
      looping.opened.fire(repo(NESTED));
      await flush();
    }
    const fourToggles = [listed(NESTED), ...FULL_TOGGLE, ...FULL_TOGGLE, ...FULL_TOGGLE, ...FULL_TOGGLE];
    assert.deepEqual(looping.events, fourToggles);
    assert.ok(looping.logs.includes(`scm: left open ${NESTED}: Git keeps reopening it right after each drop`));
    looping.clock.now = 10_000;
    looping.opened.fire(repo(NESTED));
    await flush();
    assert.deepEqual(looping.events, [...fourToggles, ...FULL_TOGGLE]);

    // A canonical root behind a junction is the followed repository, not a stray, and a stray is listed as Git spells it; a path that cannot resolve is compared as written and never keeps a repository open.
    const LINK = "C:\\Users\\me\\link";
    const junction = setup({ followed: [LINK], roots: [REPO_A], realpath: async (path) => (path === LINK ? REPO_A : path) });
    await junction.guard.activate();
    assert.deepEqual(junction.events, []);
    const spelled = setup({ followed: [REPO_A], roots: [REPO_A, LINK], realpath: async (path) => (path === LINK ? REPO_B : path) });
    await spelled.guard.activate();
    assert.deepEqual(spelled.events, [listed(LINK), ...FULL_TOGGLE]);
    const ADDED = "C:\\Users\\me\\Projects\\deletedfolder";
    for (const missing of [REPO_B, REPO_A, ANCHOR, ADDED]) {
      const gone = setup({
        followed: [REPO_A, ADDED],
        roots: [REPO_A, REPO_B],
        repos: [REPO_A],
        realpath: async (path) => {
          if (path === missing) throw new Error("ENOENT");
          return path;
        },
      });
      await gone.guard.activate();
      assert.deepEqual(gone.events, [listed(REPO_B), ...FULL_TOGGLE], missing);
      assert.deepEqual(gone.roots.list, [REPO_A], missing);
      assert.equal(
        gone.logs.some((line) => line.startsWith(`scm: no real path for ${missing}`)),
        missing === REPO_A || missing === REPO_B,
        missing,
      );
    }
    const folderGone = setup({ followed: [REPO_A], roots: [REPO_B], realpath: async () => Promise.reject(new Error("ENOENT")) });
    await folderGone.guard.activate();
    assert.deepEqual(folderGone.events, [listed(REPO_B), ...FULL_TOGGLE]);

    // Dispose leaves no listener behind on Git's events.
    retained.guard.dispose();
    assert.equal(retained.opened.count(), 0);
    assert.equal(retained.gitEntry.count(), 0);
    assert.equal(retained.anchorEntry.count(), 0);
  });

  it("never strands Git disabled through rejected writes, folder changes during a pass, or a leftover false", async () => {
    // A rejected false-write wrote nothing, so the record must not claim a value it does not own.
    const noFalse = setup({ followed: [PARENT], roots: [NESTED], updateFails: (key, value) => key === "enabled" && value === false });
    await noFalse.guard.activate();
    await flush();
    assert.deepEqual(noFalse.events, [listed(NESTED), "record in-flight", "record undefined"]);
    assert.equal(noFalse.state.record, undefined);
    assert.ok(noFalse.logs.some((line) => line.includes("file is dirty")));

    // A dirty workspace file outlasts the retries, and saving it is the one event that may ever come: that save reruns the pass.
    let refusing = true;
    const refused = setup({ followed: [PARENT], roots: [NESTED], updateFails: (key, value) => refusing && key === "enabled" && value === false });
    await refused.guard.activate();
    await flush();
    const refusedOnce = [listed(NESTED), "record in-flight", "record undefined"];
    assert.deepEqual(refused.events, refusedOnce);
    refusing = false;
    refused.saved.fire();
    await flush();
    assert.deepEqual(refused.events, [...refusedOnce, ...FULL_TOGGLE]);

    // Nothing is waiting once a pass has worked, so a stray shown now waits for its own open event rather than any configuration change.
    refused.roots.list = [NESTED];
    refused.configChange.fire();
    refused.saved.fire();
    await flush();
    assert.deepEqual(refused.events, [...refusedOnce, ...FULL_TOGGLE]);

    // A configuration change ends the wait as a save does, as reverting the file fires no save.
    let reverting = true;
    const reverted = setup({ followed: [PARENT], roots: [NESTED], updateFails: (key, value) => reverting && key === "enabled" && value === false });
    await reverted.guard.activate();
    await flush();
    reverting = false;
    reverted.configChange.fire();
    await flush();
    assert.deepEqual(reverted.events.slice(-FULL_TOGGLE.length), FULL_TOGGLE);

    // A rejected list write stops the pass before any toggle, as a toggle without the entry could not hold the stray down; the save reruns it.
    let listRefused = true;
    const noList = setup({ followed: [PARENT], roots: [NESTED], updateFails: (key) => listRefused && key === "ignoredRepositories" });
    await noList.guard.activate();
    await flush();
    assert.deepEqual(noList.events, []);
    listRefused = false;
    noList.saved.fire();
    await flush();
    assert.deepEqual(noList.events, [listed(NESTED), ...FULL_TOGGLE]);

    // Triggers that land during a failed pass still get their pass, as no later event may come; a save there comes before the rejection marks anything as waiting.
    for (const fire of ["opened", "saved"] as const) {
      const midFailure = setup({
        followed: [PARENT],
        roots: [NESTED],
        updateFails: (key, value) => {
          if (key !== "enabled" || value !== false || midFailure.events.includes("record undefined")) return false;
          if (fire === "opened") midFailure.opened.fire(repo(NESTED));
          else midFailure.saved.fire();
          return true;
        },
      });
      await midFailure.guard.activate();
      await flush();
      assert.deepEqual(midFailure.events, [listed(NESTED), "record in-flight", "record undefined", ...FULL_TOGGLE], fire);
    }

    // A folder change during the false write: the false still comes out, nothing from the old space counts against the new one, and the rerun lifts the entry the old space's pass gave the new followed root.
    let moving = true;
    const moved = setup({
      followed: [REPO_A],
      roots: [REPO_A, REPO_B, NESTED],
      repos: [REPO_A, REPO_B],
      survivors: [NESTED],
      updateFails: (key, value) => {
        if (moving && key === "enabled" && value === false) {
          moving = false;
          moved.state.folders = [ANCHOR, REPO_B];
          moved.folderChange.fire();
        }
        return false;
      },
    });
    await moved.guard.activate();
    await flush();
    assert.deepEqual(moved.events, [listed(REPO_B, NESTED), ...FULL_TOGGLE, listed(NESTED), ...FULL_TOGGLE]);
    assert.ok(!moved.logs.some((line) => line.includes("left open")));
    assert.ok(moved.roots.list.includes(REPO_B));

    // A folder change during the list write: no toggle for the space just left, and the rerun decides for the new one.
    let leaving = true;
    const left = setup({
      followed: [REPO_A],
      roots: [REPO_A, REPO_B],
      updateFails: (key) => {
        if (leaving && key === "ignoredRepositories") {
          leaving = false;
          left.state.folders = [ANCHOR, REPO_B];
          left.folderChange.fire();
        }
        return false;
      },
    });
    await left.guard.activate();
    await flush();
    assert.deepEqual(left.events, [listed(REPO_B), listed(REPO_A), ...FULL_TOGGLE]);

    // A rejected removal strands the false: the record stays, the log must say Git is off, as this is the worst this module can do, and the next event's pass removes it with no reload.
    let stranding = true;
    const stranded = setup({ followed: [PARENT], roots: [NESTED], updateFails: (key, value) => stranding && key === "enabled" && value === undefined });
    await stranded.guard.activate();
    await flush();
    assert.equal(stranded.state.record, "in-flight");
    assert.equal(stranded.settings["enabled"], false);
    assert.deepEqual(
      stranded.logs.filter((line) => line.includes("file is dirty")),
      ["scm: Git stays off in this window until a later event retries it, git.enabled false could not be removed: file is dirty"],
    );
    stranding = false;
    stranded.configChange.fire();
    await flush();
    assert.equal(stranded.state.record, undefined);
    assert.equal(stranded.settings["enabled"], undefined);

    // The leftover is removed before anything else, even with no Git model, since only the removal brings the model back.
    const leftover = setup({ record: "in-flight", settings: { enabled: false }, extension: "missing" });
    await leftover.guard.activate();
    assert.deepEqual(leftover.events, ["update enabled=undefined", "record undefined"]);
    const staleRecord = setup({ record: "in-flight" });
    await staleRecord.guard.activate();
    assert.deepEqual(staleRecord.events, ["record undefined"]);
    const userFalse = setup({ settings: { enabled: false } });
    await userFalse.guard.activate();
    assert.deepEqual(userFalse.events, [], "with no record the false is the user's own");

    // A rejected removal with no model yet: no Git event can come, so the workspace file's own events retry it with no reload, and Git starts on the enablement that follows.
    for (const fire of ["saved", "configChange"] as const) {
      let dirty = true;
      const noModel = setup({ extension: "disabled", followed: [REPO_A], record: "in-flight", settings: { enabled: false }, updateFails: (key, value) => dirty && key === "enabled" && value === undefined });
      await noModel.guard.activate();
      assert.equal(noModel.settings["enabled"], false, fire);
      assert.equal(noModel.state.record, "in-flight", fire);
      noModel[fire].fire();
      await flush();
      assert.equal(noModel.settings["enabled"], false, "a retry against a file still dirty changes nothing");
      dirty = false;
      noModel[fire].fire();
      await flush();
      assert.equal(noModel.settings["enabled"], undefined, fire);
      assert.equal(noModel.state.record, undefined, fire);
      assert.equal(noModel.opened.count(), 0, "no model yet");
      noModel.enablement.fire(true);
      await flush();
      assert.equal(noModel.opened.count(), 1, fire);
      noModel.guard.dispose();
      assert.equal(noModel.configChange.count(), 0, fire);
      assert.equal(noModel.saved.count(), 0, fire);
    }
  });

  it("opens only the followed folder's new repository, once its entry is lifted, and says when the open fails", async () => {
    // Detection is off, so only this event shows a repository the followed folder gains; opening before `git init` has filled `.git` would find none.
    const gained = setup({ followed: [PARENT], holdSettle: true });
    await gained.guard.activate();
    gained.gitEntry.fire(uri(PARENT));
    await flush();
    assert.deepEqual(gained.openCalls, []);
    gained.settles[0]?.();
    await flush();
    assert.deepEqual(gained.openCalls, [PARENT]);
    assert.deepEqual(gained.events, ["open"]);

    // The open runs after the followed folder's entry is lifted, since a listed root would open nothing.
    const gainedListed = setup({ followed: [PARENT], state: "uninitialized", settings: { ignoredRepositories: [PARENT] } });
    await gainedListed.guard.activate();
    gainedListed.gitEntry.fire(uri(PARENT));
    await flush();
    assert.deepEqual(gainedListed.events, [UNLISTED, "open"]);

    // A switch during the wait must not open the space just left: that would be a second repository.
    gained.gitEntry.fire(uri(PARENT));
    await flush();
    gained.state.folders = [ANCHOR, REPO_A];
    gained.settles[1]?.();
    await flush();
    assert.deepEqual(gained.openCalls, [PARENT]);

    // The anchor and a departed folder are never opened, and neither is a plain window's second folder.
    const elsewhere = setup({ followed: [PARENT] });
    await elsewhere.guard.activate();
    elsewhere.gitEntry.fire(uri(ANCHOR));
    elsewhere.gitEntry.fire(uri(REPO_A));
    await flush();
    assert.deepEqual(elsewhere.openCalls, []);
    const plainGained = setup({ navigator: false, followed: [PARENT] });
    await plainGained.guard.activate();
    plainGained.gitEntry.fire(uri(PARENT));
    await flush();
    assert.deepEqual(plainGained.openCalls, []);

    // A root at or above the followed folder already serves it, and opening another would show two.
    for (const root of [PARENT, "C:\\Users\\me\\Projects"]) {
      const served = setup({ followed: [PARENT], roots: [root] });
      await served.guard.activate();
      served.gitEntry.fire(uri(PARENT));
      await flush();
      assert.deepEqual(served.openCalls, [], root);
    }

    // A failed open is said, since the view would otherwise sit on the Initialize offer with no reason given.
    const noRepository = setup({ followed: [PARENT], open: async () => null });
    await noRepository.guard.activate();
    noRepository.gitEntry.fire(uri(PARENT));
    await flush();
    assert.equal(noRepository.logs.length, 1);

    // A `git init` slower than the wait gets exactly one more open on the next event, and no loop of its own.
    noRepository.opened.fire(repo(REPO_A));
    await flush();
    assert.deepEqual(noRepository.openCalls, [PARENT, PARENT]);
    noRepository.opened.fire(repo(REPO_A));
    await flush();
    assert.deepEqual(noRepository.openCalls, [PARENT, PARENT]);
    const openFails = setup({ followed: [PARENT], open: async () => Promise.reject(new Error("spawn failed")) });
    await openFails.guard.activate();
    openFails.gitEntry.fire(uri(PARENT));
    await flush();
    assert.ok(openFails.logs.some((line) => line.includes("spawn failed")));
  });

  it("opens the next space's repository first within a bound, and never fails the switch", async () => {
    // Open first: the target's entry goes before the open, as a listed root opens nothing, while another space's entry stays; the open event of the target is not a stray's, so the old repository stays with it and nothing toggles.
    const incoming = setup({ followed: [REPO_A], roots: [REPO_A], settings: { ignoredRepositories: [REPO_B, NESTED] } });
    await incoming.guard.activate();
    await incoming.guard.prepareSwitch(REPO_B, () => true);
    const openedFirst = [listed(NESTED), "open"];
    assert.deepEqual(incoming.events, openedFirst);
    incoming.roots.list = [REPO_A, REPO_B];
    incoming.opened.fire(repo(REPO_B));
    await flush();
    assert.deepEqual(incoming.events, openedFirst);
    // The swap removes the old repository with no drop, and ends the mark: the same root back as a stray in the next space is dropped.
    incoming.state.folders = [ANCHOR, REPO_B];
    incoming.roots.list = [REPO_B];
    incoming.folderChange.fire();
    incoming.runDeferred();
    await flush();
    assert.deepEqual(incoming.events, openedFirst);
    incoming.state.folders = [ANCHOR, REPO_A];
    incoming.roots.list = [REPO_A, REPO_B];
    incoming.folderChange.fire();
    incoming.runDeferred();
    await flush();
    assert.deepEqual(incoming.events, [...openedFirst, listed(NESTED, REPO_B), ...FULL_TOGGLE]);

    // A subfolder target opens its repository's root, and a root Git spells through a junction is still the incoming one.
    const LINKED = "C:\\Users\\me\\linked";
    const throughLink = setup({ followed: [REPO_A], roots: [REPO_A], rootOf: async () => uri(LINKED), realpath: async (path) => (path === LINKED ? REPO_B : path) });
    await throughLink.guard.activate();
    await throughLink.guard.prepareSwitch(`${LINKED}\\sub`, () => true);
    assert.deepEqual(throughLink.openCalls, [LINKED]);
    throughLink.roots.list = [REPO_A, REPO_B];
    throughLink.opened.fire(repo(REPO_B));
    await flush();
    assert.deepEqual(throughLink.events, ["open"]);

    // No `.git` at or above the target means no wait: nothing opens and no bound starts. The same goes for a target already superseded, a plain window, and Git not there yet.
    const noGitTarget = setup({ followed: [REPO_A], roots: [REPO_A], rootOf: async () => undefined });
    await noGitTarget.guard.activate();
    await noGitTarget.guard.prepareSwitch(PARENT, () => true);
    const superseded = setup({ followed: [REPO_A], roots: [REPO_A], settings: { ignoredRepositories: [REPO_B] } });
    await superseded.guard.activate();
    await superseded.guard.prepareSwitch(REPO_B, () => false);
    const plainSwitch = setup({ navigator: false, followed: [REPO_A] });
    await plainSwitch.guard.activate();
    await plainSwitch.guard.prepareSwitch(REPO_B, () => true);
    const noGitYet = setup({ extension: "disabled", followed: [REPO_A] });
    await noGitYet.guard.activate();
    await noGitYet.guard.prepareSwitch(REPO_B, () => true);
    for (const idle of [noGitTarget, superseded, plainSwitch, noGitYet]) {
      assert.deepEqual(idle.openCalls, []);
      assert.deepEqual(idle.bounds, []);
    }
    assert.deepEqual(superseded.events, [], "a superseded target's entry stays");

    // A repository slower than the bound stops holding the switch up the moment the bound runs out, and says so; its late open event in the swapped space is the followed root.
    const slow = setup({ followed: [REPO_A], roots: [REPO_A], open: () => new Promise(() => undefined) });
    await slow.guard.activate();
    let slowDone = false;
    void slow.guard.prepareSwitch(REPO_B, () => true).then(() => (slowDone = true));
    await flush();
    assert.deepEqual(slow.openCalls, [REPO_B]);
    assert.equal(slowDone, false, "the wait lasts while the open runs");
    slow.bounds[0]?.();
    await flush();
    assert.equal(slowDone, true);
    assert.ok(slow.logs.includes(`scm: ${REPO_B} is still opening past the bound, the switch goes on`));
    slow.state.folders = [ANCHOR, REPO_B];
    slow.roots.list = [REPO_B];
    slow.folderChange.fire();
    slow.runDeferred();
    await flush();
    slow.opened.fire(repo(REPO_B));
    await flush();
    assert.deepEqual(slow.events, ["open"]);

    // A failed open never fails the switch: each cause is said once, and the swap's own open is left to Git.
    const failedOpens: Array<[Options["open"], string]> = [
      [async () => null, `scm: Git opened no repository at ${REPO_B} ahead of the switch`],
      [async () => Promise.reject(new Error("spawn failed")), `scm: could not open ${REPO_B} ahead of the switch: spawn failed`],
    ];
    for (const [open, line] of failedOpens) {
      const failed = setup({ followed: [REPO_A], roots: [REPO_A], open });
      await failed.guard.activate();
      await failed.guard.prepareSwitch(REPO_B, () => true);
      assert.deepEqual(failed.logs, [line]);
    }
    const rootLookupFails = setup({ followed: [REPO_A], roots: [REPO_A], rootOf: async () => Promise.reject(new Error("EACCES")) });
    await rootLookupFails.guard.activate();
    await rootLookupFails.guard.prepareSwitch(REPO_B, () => true);
    assert.deepEqual(rootLookupFails.logs, ["scm: could not open the next space's repository first: EACCES"]);

    // A rejected lift leaves a listed root that would open nothing, so no open runs; the switch still goes on.
    const liftRefused = setup({ followed: [REPO_A], roots: [REPO_A], settings: { ignoredRepositories: [REPO_B] }, updateFails: (key) => key === "ignoredRepositories" });
    await liftRefused.guard.activate();
    await liftRefused.guard.prepareSwitch(REPO_B, () => true);
    assert.deepEqual(liftRefused.openCalls, []);
    assert.ok(liftRefused.logs.some((line) => line.includes("file is dirty")));

    // A swap that outran the lift leaves the open to Git, as this one could land on a space already left.
    let swapping = true;
    const outrun = setup({
      followed: [REPO_A],
      roots: [REPO_A],
      settings: { ignoredRepositories: [REPO_B] },
      updateFails: (key) => {
        if (swapping && key === "ignoredRepositories") {
          swapping = false;
          outrun.state.folders = [ANCHOR, REPO_B];
          outrun.folderChange.fire();
        }
        return false;
      },
    });
    await outrun.guard.activate();
    await outrun.guard.prepareSwitch(REPO_B, () => true);
    assert.deepEqual(outrun.openCalls, []);
  });

  it("hands a misplaced Initialize pick on to the followed folder, removing only a fresh .git from the anchor", async () => {
    // Enter on Git's pick lands in the anchor, where Git never opens it: the removal comes before the `init`, once `git init` has had the wait after its last event, so either pick attaches the followed folder, on the branch Git's own command would start from the user's settings.
    const FRESH: GitDirLook = { isDirectory: true, hasHead: true, hasHeadRef: false, hasPackedRefs: false, hasIndex: false };
    const picked = setup({ followed: [PARENT], holdSettle: true, globals: { defaultBranchName: "my branch", branchWhitespaceChar: "_" } });
    await picked.guard.activate();
    picked.state.anchorGit = FRESH;
    picked.anchorEntry.fire();
    picked.anchorEntry.fire();
    await flush();
    picked.settles[0]?.();
    await flush();
    assert.deepEqual(picked.events, [], "an earlier event's wait does not end the debounce");
    picked.settles[1]?.();
    await flush();
    const redirected = [`remove ${ANCHOR}`, `init ${PARENT}`];
    assert.deepEqual(picked.events, redirected);
    assert.deepEqual(picked.inits, [{ defaultBranch: "my_branch" }]);
    assert.ok(picked.logs.some((line) => line.includes("removed the fresh .git")));

    // A `.git` holding any work is the user's: it stays, nothing is initialised, and the log says why.
    for (const look of [{ ...FRESH, hasHeadRef: true }, { ...FRESH, hasPackedRefs: true }]) {
      const worked = setup({ followed: [PARENT] });
      await worked.guard.activate();
      worked.state.anchorGit = look;
      worked.anchorEntry.fire();
      await flush();
      assert.deepEqual(worked.events, []);
      assert.ok(worked.logs.some((line) => line.includes("alone")));
    }

    // At activation no pick is in hand, so a fresh `.git` an earlier build left only goes; one holding work stays and is said. A `.git` gone by then, or a plain window's folder, is no concern of the guard's.
    const stale = setup({ followed: [PARENT], anchorGit: FRESH });
    await stale.guard.activate();
    assert.deepEqual(stale.events, [`remove ${ANCHOR}`]);
    assert.ok(stale.logs.some((line) => line.includes("cleared the fresh .git")));
    const staleWorked = setup({ followed: [PARENT], anchorGit: { ...FRESH, hasIndex: true } });
    await staleWorked.guard.activate();
    assert.deepEqual(staleWorked.events, []);
    assert.ok(staleWorked.logs.some((line) => line.includes("alone")));
    const plainAnchor = setup({ navigator: false, followed: [PARENT], anchorGit: FRESH });
    await plainAnchor.guard.activate();
    plainAnchor.anchorEntry.fire();
    await flush();
    assert.deepEqual(plainAnchor.events, []);

    // With no followed folder there is nothing to initialise, and a followed folder with a `.git` is only opened, never initialised over.
    const noFollowed = setup();
    await noFollowed.guard.activate();
    noFollowed.state.anchorGit = FRESH;
    noFollowed.anchorEntry.fire();
    await flush();
    assert.deepEqual(noFollowed.events, [`remove ${ANCHOR}`]);
    const followedGit = setup({ followed: [PARENT], followedHasGit: true });
    await followedGit.guard.activate();
    followedGit.state.anchorGit = FRESH;
    followedGit.anchorEntry.fire();
    await flush();
    assert.deepEqual(followedGit.events, [`remove ${ANCHOR}`, "open"]);

    // A listed followed folder would open nothing, so its entry goes before the `init`.
    const listedFollowed = setup({ followed: [PARENT], state: "uninitialized", settings: { ignoredRepositories: [PARENT] } });
    await listedFollowed.guard.activate();
    listedFollowed.state.anchorGit = FRESH;
    listedFollowed.anchorEntry.fire();
    await flush();
    assert.deepEqual(listedFollowed.events, [`remove ${ANCHOR}`, UNLISTED, `init ${PARENT}`]);

    // A `git init` in a space the user has only just moved to is not what they picked, so the `.git` goes and nothing replaces it.
    const movedOn = setup({ followed: [PARENT], holdSettle: true });
    await movedOn.guard.activate();
    movedOn.state.anchorGit = FRESH;
    movedOn.anchorEntry.fire();
    await flush();
    movedOn.state.folders = [ANCHOR, REPO_A];
    movedOn.folderChange.fire();
    movedOn.runSettles();
    await flush();
    assert.deepEqual(movedOn.events, [`remove ${ANCHOR}`]);

    // A removal failing once, as `git init`'s own writes can hold it, waits and tries again; failing twice is logged and initialises nothing, since the anchor still holds the `.git`.
    const busyOnce = setup({ followed: [PARENT], removeFailures: 1, holdSettle: true });
    await busyOnce.guard.activate();
    busyOnce.state.anchorGit = FRESH;
    busyOnce.anchorEntry.fire();
    await flush();
    busyOnce.settles[0]?.();
    await flush();
    assert.deepEqual(busyOnce.events, [], "the retry waits for its own settle");
    busyOnce.settles[1]?.();
    await flush();
    assert.deepEqual(busyOnce.events, redirected);
    const busyTwice = setup({ followed: [PARENT], removeFailures: 2 });
    await busyTwice.guard.activate();
    busyTwice.state.anchorGit = FRESH;
    busyTwice.anchorEntry.fire();
    await flush();
    assert.deepEqual(busyTwice.events, []);
    assert.ok(busyTwice.logs.some((line) => line.includes("could not hand Git's Initialize pick on") && line.includes("EBUSY")));

    // An `init` that fails or opens nothing is said in the log; the view stays on Git's own Initialize text.
    const initOutcomes: Array<[Options["init"], string]> = [
      [async () => null, `scm: Git opened no repository at ${PARENT} after initialising it`],
      [async () => Promise.reject(new Error("spawn failed")), "scm: could not hand Git's Initialize pick on to the followed folder: spawn failed"],
    ];
    for (const [init, line] of initOutcomes) {
      const failedInit = setup({ followed: [PARENT], init });
      await failedInit.guard.activate();
      failedInit.state.anchorGit = FRESH;
      failedInit.anchorEntry.fire();
      await flush();
      assert.ok(failedInit.logs.includes(line));
    }
  });
});
