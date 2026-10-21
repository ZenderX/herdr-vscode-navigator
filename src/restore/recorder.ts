import { findFocusedPane } from "../follow/resolveTarget";
import type { Logger, PaneInfo, SessionSnapshot } from "../herdr";
import { errorText } from "../log";
import { normalizeCwd, samePath } from "../paths";
import { MANIFEST_VERSION } from "./manifest";
import type { ManifestPane, ManifestWorkspace, RestoreManifest } from "./manifest";
import { parseSessionFile } from "./sessionFile";
import type { LoadedSessionFile, SessionPane, SessionWorkspace } from "./sessionFile";

/** Rewrites an otherwise unchanged manifest this often so its observedAt stays fresh for the planner's staleness check. */
export const HEARTBEAT_MS = 60 * 60 * 1000;

export interface BuildOptions {
  /** Live cwd per live pane id from a shell probe; wins over the snapshot fields. */
  liveCwds?: ReadonlyMap<string, string>;
  /** Git root of the focused pane's live cwd, when the extension resolved one. */
  focusedFolder?: string;
}

export interface BuildResult {
  manifest: RestoreManifest;
  /** Live pane ids that matched no persisted pane. */
  skipped: string[];
}

interface PersistedPane {
  internalId: string;
  pane: SessionPane;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Live `p<N>` equals the public pane number of the persisted pane in the same workspace.
function publicNumber(paneId: string): number | undefined {
  const match = /:p(\d+)$/.exec(paneId);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function persistedByNumber(workspace: SessionWorkspace): Map<number, PersistedPane> {
  const numbers = workspace["public_pane_numbers"];
  const byNumber = new Map<number, PersistedPane>();
  if (!isRecord(numbers)) return byNumber;
  for (const tab of workspace.tabs) {
    for (const [internalId, pane] of Object.entries(tab.panes)) {
      const number = numbers[internalId];
      if (typeof number === "number") byNumber.set(number, { internalId, pane });
    }
  }
  return byNumber;
}

function persistedById(workspace: SessionWorkspace): Map<string, SessionPane> {
  const byId = new Map<string, SessionPane>();
  for (const tab of workspace.tabs) {
    for (const [internalId, pane] of Object.entries(tab.panes)) byId.set(internalId, pane);
  }
  return byId;
}

function agentSessionId(pane: SessionPane): string | undefined {
  const value = pane.agent_session?.["value"];
  return typeof value === "string" ? value : undefined;
}

function snapshotReading(live: PaneInfo, platform: NodeJS.Platform): string | null {
  return normalizeCwd(live.foreground_cwd ?? live.cwd, platform);
}

function labelOf(snapshot: SessionSnapshot, workspaceId: string): string | undefined {
  const entry = snapshot.workspaces.find((workspace) => workspace["workspace_id"] === workspaceId);
  const label = entry?.["label"];
  return typeof label === "string" ? label : undefined;
}

interface JoinContext {
  platform: NodeJS.Platform;
  options: BuildOptions;
  nowIso: string;
  previousPanes: ReadonlyMap<string, ManifestPane>;
}

function joinPane(live: PaneInfo, persisted: PersistedPane, context: JoinContext): ManifestPane {
  const { platform, options, nowIso, previousPanes } = context;
  const { internalId, pane } = persisted;
  const prior = previousPanes.get(internalId);
  const prevSameSpawn = prior && samePath(prior.spawnCwd, pane.cwd, platform) ? prior : undefined;
  const probed = options.liveCwds?.get(live.pane_id);
  const reading = snapshotReading(live, platform);
  // A snapshot reading equal to the spawn folder is herdr's stale value: it must not erase a better earlier reading.
  let liveCwd: string;
  if (probed !== undefined) liveCwd = probed;
  else if (reading !== null && !samePath(reading, pane.cwd, platform)) liveCwd = reading;
  else liveCwd = prevSameSpawn?.liveCwd ?? reading ?? pane.cwd;

  const agent = agentSessionId(pane);
  return {
    internalId,
    publicNumber: publicNumber(live.pane_id) ?? 0,
    spawnCwd: pane.cwd,
    ...(agent === undefined ? {} : { agentSessionId: agent }),
    liveCwd,
    observedAt: prevSameSpawn && samePath(prevSameSpawn.liveCwd, liveCwd, platform) ? prevSameSpawn.observedAt : nowIso,
  };
}

/**
 * Joins a live snapshot with the persisted session file into a restore manifest. Entries from
 * `previous` stay while the pane is still in the file, so one thin poll does not forget a folder.
 */
export function buildManifest(
  sessionFile: LoadedSessionFile,
  snapshot: SessionSnapshot,
  previous: RestoreManifest | undefined,
  now: Date,
  platform: NodeJS.Platform,
  options: BuildOptions = {},
): BuildResult {
  const prior = previous?.sessionFilePath === sessionFile.path ? previous : undefined;
  const nowIso = now.toISOString();
  const focused = findFocusedPane(snapshot);
  const skipped: string[] = [];
  const workspaces: ManifestWorkspace[] = [];

  for (const workspace of sessionFile.session.workspaces) {
    const previousWorkspace = prior?.workspaces.find(({ id }) => id === workspace.id);
    const previousPanes = new Map((previousWorkspace?.panes ?? []).map((pane) => [pane.internalId, pane]));
    const byNumber = persistedByNumber(workspace);
    const context: JoinContext = { platform, options, nowIso, previousPanes };

    const joined = new Map<string, ManifestPane>();
    for (const live of snapshot.panes.filter(({ workspace_id }) => workspace_id === workspace.id)) {
      const number = publicNumber(live.pane_id);
      const persisted = number === undefined ? undefined : byNumber.get(number);
      if (persisted === undefined) {
        skipped.push(live.pane_id);
        continue;
      }
      joined.set(persisted.internalId, joinPane(live, persisted, context));
    }

    const inFile = persistedById(workspace);
    for (const [internalId, kept] of previousPanes) {
      const persisted = inFile.get(internalId);
      if (joined.has(internalId) || persisted === undefined || !samePath(kept.spawnCwd, persisted.cwd, platform)) continue;
      joined.set(internalId, kept);
    }

    const panes = [...joined.values()];
    const [firstPane] = panes;
    if (firstPane === undefined) continue;
    const focusedNumber = focused?.workspace_id === workspace.id ? publicNumber(focused.pane_id) : undefined;
    const focusedInternalId = focusedNumber === undefined ? undefined : byNumber.get(focusedNumber)?.internalId;
    const focusedLive = panes.find(({ internalId }) => internalId === focusedInternalId);
    const folder = focusedLive ? (options.focusedFolder ?? focusedLive.liveCwd) : (previousWorkspace?.folder ?? firstPane.liveCwd);
    workspaces.push({
      id: workspace.id,
      label: labelOf(snapshot, workspace.id) ?? previousWorkspace?.label ?? workspace.id,
      folder,
      panes,
    });
  }

  return { manifest: { manifestVersion: MANIFEST_VERSION, sessionFilePath: sessionFile.path, observedAt: nowIso, workspaces }, skipped };
}

export function parseManifest(text: string): RestoreManifest | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value["manifestVersion"] !== MANIFEST_VERSION) return undefined;
    if (typeof value["sessionFilePath"] !== "string" || typeof value["observedAt"] !== "string") return undefined;
    if (!Array.isArray(value["workspaces"])) return undefined;
    return value as Record<string, unknown> & RestoreManifest;
  } catch {
    return undefined;
  }
}

export interface ManifestFs {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface StoreClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ManifestStoreOptions {
  path: string;
  /** Directory of `path`. */
  dir: string;
  fs: ManifestFs;
  clock: StoreClock;
  debounceMs: number;
  log: Logger;
}

// The content compared for "changed": the top-level observedAt moves on every poll.
function contentKey(manifest: RestoreManifest): string {
  return JSON.stringify({ ...manifest, observedAt: "" });
}

/** Debounced, atomic (temp file then rename) writer that skips unchanged content. */
export class ManifestStore {
  private pending: RestoreManifest | undefined;
  private timer: unknown = null;
  private lastKey: string | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManifestStoreOptions) {}

  save(manifest: RestoreManifest): void {
    const { clock, debounceMs } = this.options;
    const unchanged = contentKey(manifest) === this.lastKey && clock.now() - this.lastWriteAt < HEARTBEAT_MS;
    if (unchanged && this.pending === undefined) return;
    this.pending = manifest;
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastWriteAt + debounceMs - clock.now());
    this.timer = clock.setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.write());
    }, wait);
  }

  /** Writes any pending manifest now and resolves when the file is on disk. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(() => this.write());
    await this.writing;
  }

  dispose(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = undefined;
  }

  private async write(): Promise<void> {
    const { path, dir, fs, clock, log } = this.options;
    const manifest = this.pending;
    if (manifest === undefined) return;
    this.pending = undefined;
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await fs.mkdir(dir);
      await fs.writeFile(temp, JSON.stringify(manifest));
      await fs.rename(temp, path);
      this.lastKey = contentKey(manifest);
      this.lastWriteAt = clock.now();
    } catch (err: unknown) {
      log("warn", `restore manifest: write failed: ${errorText(err)}`);
    }
  }
}

export interface RecorderFs {
  stat(path: string): Promise<{ mtimeMs: number }>;
  readFile(path: string): Promise<string>;
}

export interface RecorderOptions {
  platform: NodeJS.Platform;
  sessionFilePath: string;
  fs: RecorderFs;
  store: Pick<ManifestStore, "save">;
  /** The manifest found on disk at start, if any. */
  initial?: RestoreManifest;
  /** Only the window hosting herdr records. */
  isHosting: () => boolean;
  /** Whether a socket is the default session's; checked per snapshot against the socket it was fetched from. */
  isDefaultSocket: (socket: string) => boolean;
  /** Shell-probed live cwd of a pane, when available. */
  probeLive: (paneId: string) => Promise<string | undefined>;
  /** Git root of a folder; the folder itself when none. Not consulted when the extension does not snap to git roots. */
  gitRoot: (dir: string) => Promise<string>;
  now: () => Date;
  log: Logger;
}

/** Keeps the restore manifest current from snapshots; reads session.json only when its mtime moved. */
export class ManifestRecorder {
  private manifest: RestoreManifest | undefined;
  private cached: { mtimeMs: number; file: LoadedSessionFile } | undefined;
  private busy = false;
  private readonly loggedSkips = new Set<string>();
  private lastFileProblem: string | undefined;

  constructor(private readonly options: RecorderOptions) {
    this.manifest = options.initial;
  }

  /** `socket` is the one `snapshot` was fetched from, captured at fetch time. */
  async observe(snapshot: SessionSnapshot, socket: string): Promise<void> {
    const { isHosting, isDefaultSocket, log } = this.options;
    if (!isHosting() || this.busy) return;
    try {
      if (!isDefaultSocket(socket)) return;
    } catch (err: unknown) {
      log("warn", `restore manifest: ${errorText(err)}`);
      return;
    }
    this.busy = true;
    try {
      await this.record(snapshot);
    } catch (err: unknown) {
      log("warn", `restore manifest: ${errorText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async record(snapshot: SessionSnapshot): Promise<void> {
    const { platform, probeLive, gitRoot, store, now } = this.options;
    const file = await this.loadSession();
    if (file === undefined) return;

    const options: BuildOptions = {};
    const focused = findFocusedPane(snapshot);
    if (focused) {
      const probed = await probeLive(focused.pane_id);
      const liveCwd = probed ?? snapshotReading(focused, platform);
      if (probed !== undefined) options.liveCwds = new Map([[focused.pane_id, probed]]);
      if (liveCwd !== null) options.focusedFolder = await gitRoot(liveCwd);
    }
    const { manifest, skipped } = buildManifest(file, snapshot, this.manifest, now(), platform, options);
    this.logSkips(skipped);
    this.manifest = manifest;
    store.save(manifest);
  }

  private async loadSession(): Promise<LoadedSessionFile | undefined> {
    const { fs, sessionFilePath } = this.options;
    try {
      const { mtimeMs } = await fs.stat(sessionFilePath);
      if (this.cached?.mtimeMs === mtimeMs) return this.cached.file;
      const parsed = parseSessionFile(await fs.readFile(sessionFilePath));
      if (!parsed.ok) return this.fileProblem(`session file unusable: ${parsed.reason}`);
      this.lastFileProblem = undefined;
      this.cached = { mtimeMs, file: { path: sessionFilePath, session: parsed.session } };
      return this.cached.file;
    } catch (err: unknown) {
      return this.fileProblem(`session file unreadable: ${errorText(err)}`);
    }
  }

  private fileProblem(message: string): undefined {
    if (message === this.lastFileProblem) return undefined;
    this.lastFileProblem = message;
    this.options.log("warn", `restore manifest: ${message}`);
    return undefined;
  }

  private logSkips(skipped: readonly string[]): void {
    for (const paneId of skipped) {
      const workspaceId = paneId.slice(0, paneId.lastIndexOf(":"));
      if (this.loggedSkips.has(workspaceId)) continue;
      this.loggedSkips.add(workspaceId);
      this.options.log("info", `restore manifest: pane ${paneId} has no persisted pane yet; skipped (logged once per workspace)`);
    }
  }
}
