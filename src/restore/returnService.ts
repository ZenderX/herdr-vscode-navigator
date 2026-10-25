import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MsysCwdBatch, ShellPane } from "../cwd/types";
import type { HerdrEvent, Logger, PaneInfo, PaneProcessInfo, SessionSnapshot } from "../herdr/types";
import type { PluginState } from "../launch/pluginDetect";
import { errorText } from "../log";
import { FOCUS_EVENTS, dropPanes, emptyRecord, isSpawnForm, mergePane, mergeRecord, parseRecord, recordKey, recordedFolders, setShellPids, setSpawns } from "./record";
import type { CwdRecord, MergeResult, PaneReading } from "./record";
import { isRestart } from "./restartDetect";
import { anyNotReady, paneHasAgent, planReturn, summary } from "./returnPlanner";
import type { PlannerPane, ReturnAction, ReturnPlan, ReturnSkip } from "./returnPlanner";

// The plugin's HERDR_NAV_READY_TIMEOUT and its 1 s re-read.
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 1_000;

// Events that name no pane to read, or whose interesting pane is the one left behind: recorded by a full snapshot.
const SNAPSHOT_EVENTS: ReadonlySet<string> = new Set(["tab_closed", "workspace_closed", ...FOCUS_EVENTS]);

export interface ReturnClient {
  snapshot(): Promise<SessionSnapshot>;
  processInfo(paneId: string): Promise<PaneProcessInfo>;
  sendInput(paneId: string, text: string): Promise<void>;
}

export interface RecordStore {
  read(key: string): CwdRecord;
  write(record: CwdRecord): void;
}

export interface ReturnServiceDeps {
  platform: NodeJS.Platform;
  log: Logger;
  clock: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  /** Throws when the socket path setting cannot be resolved. */
  pipeName: () => string;
  client: (pipeName: string) => ReturnClient;
  store: RecordStore;
  isDirectory: (folder: string) => Promise<boolean>;
  connected: () => boolean;
  holdsLease: () => boolean;
  pluginState: () => PluginState;
  /** One busy check per return run, so the process table is read once per run. */
  busyCheck: () => (info: PaneProcessInfo) => Promise<boolean>;
  /** Live folders of Windows Git Bash shells from one MSYS scan; rejects when the scan fails. */
  probeShells: (panes: readonly ShellPane[]) => Promise<MsysCwdBatch>;
}

export interface ReturnService {
  /** One full snapshot folded into the record; run when the subscription starts. Never rejects. */
  reconcile(): Promise<void>;
  /** A herdr event from RECORD_EVENTS or FOCUS_EVENTS. Never throws. */
  onEvent(event: HerdrEvent): void;
  /** Full snapshots the follow cycle fetched anyway. */
  observeSnapshot(snapshot: SessionSnapshot): void;
  /** The socket was lost and came back: the server restarted. Never rejects. */
  onReconnected(): Promise<void>;
}

interface ReturnRun {
  /** First spawn-form reading seen per pane during the run. */
  spawns: Map<string, string>;
  /** Process-info spawn folders of panes the run looked at, for panes without a spawn-form reading. */
  shellSpawns: ReadonlyMap<string, string>;
  sent: ReadonlySet<string>;
}

// herdr restores a pane into its shell's persisted process cwd, so the idle shell's own cwd is its spawn folder.
function shellSpawn({ shell_pid, foreground_process_group_id, foreground_processes }: PaneProcessInfo): string | undefined {
  const [shell, ...others] = foreground_processes;
  if (shell === undefined || others.length > 0 || shell.pid !== shell_pid) return undefined;
  if (typeof foreground_process_group_id === "number" && foreground_process_group_id !== shell_pid) return undefined;
  return typeof shell.cwd === "string" ? shell.cwd : undefined;
}

function noteSpawns(spawns: Map<string, string>, panes: readonly PaneInfo[]): void {
  for (const { pane_id, cwd } of panes) {
    if (typeof cwd === "string" && isSpawnForm(cwd) && !spawns.has(pane_id)) spawns.set(pane_id, cwd);
  }
}

function plannerPane(pane: PaneInfo, spawns: ReadonlyMap<string, string>, live: ReadonlyMap<string, string>): PlannerPane {
  return { paneId: pane.pane_id, rawCwd: pane.cwd, live: live.get(pane.pane_id), spawn: spawns.get(pane.pane_id), hasAgent: paneHasAgent(pane), busy: undefined };
}

function snapshotReadings(panes: readonly PaneInfo[]): PaneReading[] {
  return panes.map(({ pane_id, cwd }) => ({ paneId: pane_id, rawCwd: cwd }));
}

function liveReadings(live: ReadonlyMap<string, string>): PaneReading[] {
  return [...live].map(([paneId, rawCwd]) => ({ paneId, rawCwd }));
}

function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function paneReading(data: Record<string, unknown>): PaneReading | undefined {
  const { pane } = data;
  if (typeof pane !== "object" || pane === null || !("pane_id" in pane) || typeof pane.pane_id !== "string") return undefined;
  const cwd = "cwd" in pane && typeof pane.cwd === "string" ? pane.cwd : undefined;
  return { paneId: pane.pane_id, rawCwd: cwd };
}

/**
 * Records pane folders from herdr's pane events while this window is connected and holds the navigator lease, with
 * a full snapshot at connect, on focus changes, on tab and space closes and after a return; after a restart it types
 * `cd` into qualifying restored shells. herdr keeps a Windows Git Bash pane's cwd in spawn form, so on those events
 * its folder is read from the MSYS shell instead; a `cd` followed by no event is not seen. A restart while the window
 * was closed is seen when a recorded pane id has another shell pid at the first snapshot.
 */
export function createReturnService(deps: ReturnServiceDeps): ReturnService {
  const { log, clock, platform } = deps;
  let cached: CwdRecord | undefined;
  // Paused from restart detection until the run ends, or the restored shells' first folders would overwrite the record.
  let returning = false;
  let activationPending = true;
  let reconciling = false;
  let reconcileAgain = false;
  // Bumped by each return run: a spawn lookup started before it may have been answered by a restored pane.
  let epoch = 0;
  // Panes whose missing spawn folder was looked up once since the last run; a change of folder looks again.
  const seedTried = new Set<string>();
  // Current shell pid per pane id; cleared by a restart, dropped when an id gets a new pane.
  const shellPids = new Map<string, number>();

  const load =(pipeName: string): CwdRecord => {
    const key = recordKey(pipeName);
    if (cached?.key !== key) cached = deps.store.read(key);
    return cached;
  };

  const recordingAllowed = (): boolean => !returning && deps.connected() && deps.holdsLease();

  const save = ({ record, changed }: MergeResult): void => {
    if (!changed) return;
    cached = record;
    try {
      deps.store.write(record);
    } catch (err: unknown) {
      log("warn", `cwd-return: record write failed: ${errorText(err)}`);
    }
  };

  const saveWithPids = (merged: MergeResult, pids: ReadonlyMap<string, number>): void => {
    const withPids = setShellPids(merged.record, pids);
    save({ record: withPids.record, changed: merged.changed || withPids.changed });
  };

  // One process-info read per pane id not seen since the last restart; failed lookups are retried next time.
  const pidsFor = async (client: ReturnClient, paneIds: readonly string[]): Promise<Map<string, number>> => {
    const startedIn = epoch;
    const pids = new Map<string, number>();
    for (const paneId of paneIds) {
      const known = shellPids.get(paneId);
      if (known !== undefined) {
        pids.set(paneId, known);
        continue;
      }
      try {
        const { shell_pid } = await client.processInfo(paneId);
        pids.set(paneId, shell_pid);
        if (epoch === startedIn) shellPids.set(paneId, shell_pid);
      } catch (err: unknown) {
        log("debug", `cwd-return: process info for ${paneId} failed: ${errorText(err)}`);
      }
    }
    return pids;
  };

  // herdr's cwd of a Windows Git Bash pane stays in spawn form, so the live folder is read from its MSYS shell.
  const isProbeCandidate = (rawCwd: string | null | undefined): boolean => platform === "win32" && isSpawnForm(rawCwd);

  /** MSYS probe folders of the candidate readings with a known pid; a failed scan is logged and reads nothing. */
  const probeLive = async (pids: ReadonlyMap<string, number>, readings: readonly PaneReading[]): Promise<Map<string, string>> => {
    const shells = readings.flatMap(({ paneId, rawCwd }) => {
      const shellPid = pids.get(paneId);
      return shellPid !== undefined && isProbeCandidate(rawCwd) ? [{ paneId, shellPid }] : [];
    });
    if (shells.length === 0) return new Map();
    try {
      const batch = await deps.probeShells(shells);
      return new Map([...batch].flatMap(([paneId, reading]) => (reading === undefined ? [] : [[paneId, reading.cwd] as const])));
    } catch (err: unknown) {
      log("warn", `cwd-return: Git Bash folder probe failed: ${errorText(err)}`);
      return new Map();
    }
  };

  const candidateIds = (readings: readonly PaneReading[]): string[] => readings.filter(({ rawCwd }) => isProbeCandidate(rawCwd)).map(({ paneId }) => paneId);

  // One process-info read per pane whose recorded folder just changed or whose spawn folder is missing.
  const learnSpawns = (before: CwdRecord, pipeName: string): void => {
    const paneIds = Object.entries(load(pipeName).panes).flatMap(([paneId, { folder, spawn }]) => {
      if (folder === undefined) return [];
      if (folder !== before.panes[paneId]?.folder) return [paneId];
      return spawn === undefined && !seedTried.has(paneId) ? [paneId] : [];
    });
    if (paneIds.length === 0) return;
    for (const paneId of paneIds) seedTried.add(paneId);
    const startedIn = epoch;
    const lookup = async (): Promise<void> => {
      const client = deps.client(pipeName);
      const readings: PaneReading[] = [];
      const pids = new Map<string, number>();
      for (const paneId of paneIds) {
        try {
          const info = await client.processInfo(paneId);
          pids.set(paneId, info.shell_pid);
          const spawn = shellSpawn(info);
          if (spawn !== undefined) readings.push({ paneId, rawCwd: spawn });
        } catch (err: unknown) {
          log("debug", `cwd-return: process info for ${paneId} failed: ${errorText(err)}`);
        }
      }
      if (epoch !== startedIn || !recordingAllowed()) return;
      for (const [paneId, pid] of pids) shellPids.set(paneId, pid);
      saveWithPids(setSpawns(load(pipeName), readings, platform), pids);
    };
    lookup().catch((err: unknown) => log("warn", `cwd-return: spawn folder lookup failed: ${errorText(err)}`));
  };

  const waitForPrompts = async (client: ReturnClient, recorded: CwdRecord["panes"], folderExists: (folder: string) => boolean | undefined, spawns: Map<string, string>) => {
    const deadline = clock.now() + READY_TIMEOUT_MS;
    for (;;) {
      const snapshot = await client.snapshot();
      noteSpawns(spawns, snapshot.panes);
      const waiting = snapshotReadings(snapshot.panes).filter(({ paneId }) => recorded[paneId]?.folder !== undefined);
      const live = await probeLive(await pidsFor(client, candidateIds(waiting)), waiting);
      const panes = snapshot.panes.map((pane) => plannerPane(pane, spawns, live));
      const plan = planReturn({ recorded, panes, folderExists, platform });
      if (!anyNotReady(plan) || clock.now() >= deadline) return { panes, plan };
      await clock.sleep(READY_POLL_MS);
    }
  };

  const busyVerdicts = async (client: ReturnClient, plan: ReturnPlan, recorded: CwdRecord["panes"]) => {
    const isBusy = deps.busyCheck();
    const busy = new Map<string, boolean>();
    const failed = new Set<string>();
    const shellSpawns = new Map<string, string>();
    // A pane already live at the first look showed no spawn form; the process info read for its busy check has the spawn folder.
    const unchecked = plan.skips.filter(({ paneId, reason }) => reason === "unknown-spawn" && recorded[paneId]?.spawn !== undefined);
    for (const { paneId } of [...plan.actions, ...unchecked]) {
      try {
        const info = await client.processInfo(paneId);
        const spawn = shellSpawn(info);
        if (spawn !== undefined) shellSpawns.set(paneId, spawn);
        busy.set(paneId, await isBusy(info));
      } catch (err: unknown) {
        failed.add(paneId);
        log("debug", `cwd-return: process info for ${paneId} failed: ${errorText(err)}`);
      }
    }
    return { busy, failed, shellSpawns };
  };

  /** Undefined when this window does not return panes; recording then waits for the next event. */
  const returnPanes = async (seen: SessionSnapshot | undefined): Promise<ReturnRun | undefined> => {
    if (!deps.holdsLease()) return undefined;
    const pipeName = deps.pipeName();
    const record = load(pipeName);
    const recorded = record.panes;
    const folders = [...new Set(Object.values(recordedFolders(record)))];
    const spawns = new Map<string, string>();
    if (folders.length === 0) return { spawns, shellSpawns: new Map(), sent: new Set() };
    if (deps.pluginState() === "present") {
      log("info", "cwd-return: deferred to herdr plugin");
      return undefined;
    }

    if (seen) noteSpawns(spawns, seen.panes);
    const exists = new Map(await Promise.all(folders.map(async (folder) => [folder, await deps.isDirectory(folder)] as const)));
    const folderExists = (folder: string): boolean | undefined => exists.get(folder);
    const client = deps.client(pipeName);
    const ready = await waitForPrompts(client, recorded, folderExists, spawns);
    const { busy, failed, shellSpawns } = await busyVerdicts(client, ready.plan, recorded);
    const panes = ready.panes.map((pane) => ({ ...pane, spawn: pane.spawn ?? shellSpawns.get(pane.paneId), busy: busy.get(pane.paneId) }));
    const plan = planReturn({ recorded, panes, folderExists, platform });

    const sent: ReturnAction[] = [];
    const skips: ReturnSkip[] = [...plan.skips];
    for (const action of plan.actions) {
      if (failed.has(action.paneId)) {
        skips.push({ paneId: action.paneId, reason: "error" });
        continue;
      }
      try {
        await client.sendInput(action.paneId, action.text);
        sent.push(action);
      } catch (err: unknown) {
        skips.push({ paneId: action.paneId, reason: "error" });
        log("debug", `cwd-return: send to ${action.paneId} failed: ${errorText(err)}`);
      }
    }
    log("info", summary(sent, skips));
    return { spawns, shellSpawns, sent: new Set(sent.map(({ paneId }) => paneId)) };
  };

  // The run's spawn folders key the restored panes, and a mismatched entry is reset here.
  const reconcileAfterReturn = async ({ spawns, shellSpawns, sent }: ReturnRun): Promise<void> => {
    if (!recordingAllowed()) return;
    try {
      const pipeName = deps.pipeName();
      const client = deps.client(pipeName);
      const { panes } = await client.snapshot();
      const present = new Set(panes.map(({ pane_id }) => pane_id));
      // The restored panes' new pids key the next activation's restart check.
      const pids = await pidsFor(client, [...present]);
      // A returned shell may not have run its cd yet; its reading would record the folder it was restored in.
      const unsent = snapshotReadings(panes).filter(({ paneId }) => !sent.has(paneId));
      const live = await probeLive(pids, unsent);
      if (!recordingAllowed()) return;
      const record = load(pipeName);
      const spawnReadings = [...spawns].filter(([paneId]) => present.has(paneId)).map(([paneId, rawCwd]) => ({ paneId, rawCwd }));
      const readings = panes.map(({ pane_id, cwd }) => ({ paneId: pane_id, rawCwd: sent.has(pane_id) ? record.panes[pane_id]?.folder : cwd }));
      const merged = mergeRecord(record, [...spawnReadings, ...readings, ...liveReadings(live)], platform);
      const shellReadings = [...shellSpawns].filter(([paneId]) => present.has(paneId) && !spawns.has(paneId)).map(([paneId, rawCwd]) => ({ paneId, rawCwd }));
      const withSpawns = setSpawns(merged.record, shellReadings, platform);
      saveWithPids({ record: withSpawns.record, changed: merged.changed || withSpawns.changed }, pids);
    } catch (err: unknown) {
      log("warn", `cwd-return: reconcile after return failed: ${errorText(err)}`);
    }
  };

  const runReturn = async (seen?: SessionSnapshot): Promise<void> => {
    if (returning) return;
    returning = true;
    epoch++;
    seedTried.clear();
    shellPids.clear();
    let run: ReturnRun | undefined;
    try {
      run = await returnPanes(seen);
    } catch (err: unknown) {
      log("warn", `cwd-return: failed: ${errorText(err)}`);
    } finally {
      returning = false;
    }
    if (run) await reconcileAfterReturn(run);
  };

  // The first snapshot of this activation is checked for freshly restored shells before it may touch the record.
  const handleSnapshot = async (snapshot: SessionSnapshot, pipeName: string): Promise<void> => {
    const readings = snapshotReadings(snapshot.panes);
    const startedIn = epoch;
    const client = deps.client(pipeName);
    const pids = await pidsFor(client, readings.map(({ paneId }) => paneId));
    if (activationPending && deps.holdsLease()) {
      activationPending = false;
      if (isRestart({ kind: "connected", shellPids: pids, recorded: load(pipeName).panes })) {
        void runReturn(snapshot);
        return;
      }
    }
    const live = await probeLive(pids, readings);
    if (epoch !== startedIn || !recordingAllowed()) return;
    const before = load(pipeName);
    // Each pane's herdr reading first, so a reused id is reset before its probe folder is set.
    saveWithPids(mergeRecord(before, [...readings, ...liveReadings(live)], platform), pids);
    learnSpawns(before, pipeName);
  };

  // A pane event's own reading is in spawn form for Git Bash, so that pane alone is probed.
  const recordLive = async (reading: PaneReading, before: CwdRecord, pipeName: string): Promise<void> => {
    const startedIn = epoch;
    const pids = await pidsFor(deps.client(pipeName), [reading.paneId]);
    const live = await probeLive(pids, [reading]);
    if (epoch !== startedIn || !recordingAllowed()) return;
    saveWithPids(mergePane(load(pipeName), { paneId: reading.paneId, rawCwd: live.get(reading.paneId) }, platform), pids);
    learnSpawns(before, pipeName);
  };

  // A close during an in-flight snapshot may predate it, so one more snapshot follows.
  const reconcile = async (): Promise<void> => {
    if (!recordingAllowed()) return;
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        const pipeName = deps.pipeName();
        const snapshot = await deps.client(pipeName).snapshot();
        if (!returning) await handleSnapshot(snapshot, pipeName);
      } while (reconcileAgain && recordingAllowed());
    } catch (err: unknown) {
      log("warn", `cwd-return: reconcile failed: ${errorText(err)}`);
    } finally {
      reconciling = false;
    }
  };

  /** Folds the event in and returns the pane reading it carried, if any. */
  const applyEvent = ({ event, data }: HerdrEvent): PaneReading | undefined => {
    const record = load(deps.pipeName());
    if (event === "pane_closed" || event === "pane_exited") {
      const paneId = textField(data, "pane_id");
      if (paneId === undefined) return void log("warn", `cwd-return: ${event} without a pane id`);
      shellPids.delete(paneId);
      return void save(dropPanes(record, [paneId]));
    }
    const reading = paneReading(data);
    if (reading === undefined) return void log("warn", `cwd-return: ${event} without a pane`);
    if (event === "pane_created") shellPids.delete(reading.paneId);
    if (event !== "pane_moved") {
      save(mergePane(record, reading, platform));
      return reading;
    }
    // A move to another space gives the pane a new id; the old one is retired.
    const previous = textField(data, "previous_pane_id");
    shellPids.delete(reading.paneId);
    if (previous !== undefined) shellPids.delete(previous);
    const dropped = previous === undefined ? { record, changed: false } : dropPanes(record, [previous]);
    const merged = mergePane(dropped.record, reading, platform);
    save({ record: merged.record, changed: dropped.changed || merged.changed });
    return reading;
  };

  return {
    reconcile,
    onEvent: (event) => {
      if (!recordingAllowed()) return;
      if (activationPending || SNAPSHOT_EVENTS.has(event.event)) {
        void reconcile();
        return;
      }
      try {
        const pipeName = deps.pipeName();
        const before = load(pipeName);
        const reading = applyEvent(event);
        if (reading === undefined || !isProbeCandidate(reading.rawCwd)) return learnSpawns(before, pipeName);
        recordLive(reading, before, pipeName).catch((err: unknown) => log("warn", `cwd-return: ${event.event} not recorded: ${errorText(err)}`));
      } catch (err: unknown) {
        log("warn", `cwd-return: ${event.event} not recorded: ${errorText(err)}`);
      }
    },
    // Passive: herdr's cwds only, no probe; the connect reconcile owns the activation's restart check.
    observeSnapshot: (snapshot) => {
      if (returning || activationPending || !recordingAllowed()) return;
      try {
        const pipeName = deps.pipeName();
        const before = load(pipeName);
        save(mergeRecord(before, snapshotReadings(snapshot.panes), platform));
        learnSpawns(before, pipeName);
      } catch (err: unknown) {
        log("warn", `cwd-return: snapshot not recorded: ${errorText(err)}`);
      }
    },
    onReconnected: () => {
      activationPending = false;
      return runReturn();
    },
  };
}

/** `<dir>/cwd-return-<key>.json`; a missing file is an empty record, a malformed one is logged and replaced. */
export function fileRecordStore(dir: string, log: Logger): RecordStore {
  const file = (key: string): string => path.join(dir, `cwd-return-${key}.json`);
  return {
    read: (key) => {
      let text: string;
      try {
        text = readFileSync(file(key), "utf8");
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return emptyRecord(key);
        log("warn", `cwd-return: record read failed: ${errorText(err)}`);
        return emptyRecord(key);
      }
      try {
        const parsed = parseRecord(JSON.parse(text));
        if (parsed?.key === key) return parsed;
      } catch (err: unknown) {
        log("warn", `cwd-return: record parse failed: ${errorText(err)}`);
        return emptyRecord(key);
      }
      log("warn", `cwd-return: record ${file(key)} malformed; starting empty`);
      return emptyRecord(key);
    },
    // Temp file and rename, as for the lease, so another window never reads a half-written record.
    write: (record) => {
      const target = file(record.key);
      mkdirSync(dir, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(record), "utf8");
      renameSync(temp, target);
    },
  };
}
