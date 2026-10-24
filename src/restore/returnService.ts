import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger, PaneInfo, PaneProcessInfo, SessionSnapshot } from "../herdr/types";
import type { PluginState } from "../launch/pluginDetect";
import { errorText } from "../log";
import { emptyRecord, isCwdRecord, mergeRecord, recordKey } from "./record";
import type { CwdRecord } from "./record";
import { isRestart } from "./restartDetect";
import { anyNotReady, paneHasAgent, planReturn, summary } from "./returnPlanner";
import type { PlannerPane, ReturnAction, ReturnPlan, ReturnSkip } from "./returnPlanner";

// The plugin's cwd-track cadence.
const RECORD_POLL_MS = 3_000;
// The plugin's HERDR_NAV_READY_TIMEOUT and its 1 s re-read.
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 1_000;

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
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
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
}

export interface ReturnService {
  start(): void;
  stop(): void;
  /** One record poll; the timer runs it every RECORD_POLL_MS. Never rejects. */
  poll(): Promise<void>;
  /** Full snapshots the follow cycle fetched anyway. */
  observeSnapshot(snapshot: SessionSnapshot): void;
  /** The socket was lost and came back: the server restarted. Never rejects. */
  onReconnected(): Promise<void>;
}

function plannerPane(pane: PaneInfo): PlannerPane {
  return { paneId: pane.pane_id, rawCwd: pane.cwd, hasAgent: paneHasAgent(pane), busy: undefined };
}

/**
 * Records live pane folders while this window is connected and holds the navigator lease and, after a restart,
 * types `cd` into qualifying restored shells. A restart while the window was closed is seen only if a recorded
 * pane is still in spawn form at the first snapshot; once every recorded pane has drawn its first prompt it reads
 * as the user changing folder and is missed.
 */
export function createReturnService(deps: ReturnServiceDeps): ReturnService {
  const { log, clock, platform } = deps;
  let cached: CwdRecord | undefined;
  let timer: unknown;
  let stopped = false;
  // Paused from restart detection until the run ends, or the restored shells' first folders would overwrite the record.
  let returning = false;
  let activationPending = true;

  const load = (pipeName: string): CwdRecord => {
    const key = recordKey(pipeName);
    if (cached?.key !== key) cached = deps.store.read(key);
    return cached;
  };

  const recordingAllowed = (): boolean => !returning && deps.connected() && deps.holdsLease();

  const merge = (snapshot: SessionSnapshot, pipeName: string): void => {
    const readings = snapshot.panes.map(({ pane_id, cwd }) => ({ paneId: pane_id, rawCwd: cwd }));
    const { record, changed } = mergeRecord(load(pipeName), readings, platform);
    if (!changed) return;
    cached = record;
    try {
      deps.store.write(record);
    } catch (err: unknown) {
      log("warn", `cwd-return: record write failed: ${errorText(err)}`);
    }
  };

  const waitForPrompts = async (client: ReturnClient, recorded: CwdRecord["panes"], folderExists: (folder: string) => boolean | undefined) => {
    const deadline = clock.now() + READY_TIMEOUT_MS;
    for (;;) {
      const panes = (await client.snapshot()).panes.map(plannerPane);
      const plan = planReturn({ recorded, panes, folderExists, platform });
      if (!anyNotReady(plan) || clock.now() >= deadline) return { panes, plan };
      await clock.sleep(READY_POLL_MS);
    }
  };

  const busyVerdicts = async (client: ReturnClient, plan: ReturnPlan) => {
    const isBusy = deps.busyCheck();
    const busy = new Map<string, boolean>();
    const failed = new Set<string>();
    for (const { paneId } of plan.actions) {
      try {
        busy.set(paneId, await isBusy(await client.processInfo(paneId)));
      } catch (err: unknown) {
        failed.add(paneId);
        log("debug", `cwd-return: process info for ${paneId} failed: ${errorText(err)}`);
      }
    }
    return { busy, failed };
  };

  const returnPanes = async (): Promise<void> => {
    if (!deps.holdsLease()) return;
    const pipeName = deps.pipeName();
    const { panes: recorded } = load(pipeName);
    const folders = [...new Set(Object.values(recorded))];
    if (folders.length === 0) return;
    if (deps.pluginState() === "present") return log("info", "cwd-return: deferred to herdr plugin");

    const exists = new Map(await Promise.all(folders.map(async (folder) => [folder, await deps.isDirectory(folder)] as const)));
    const folderExists = (folder: string): boolean | undefined => exists.get(folder);
    const client = deps.client(pipeName);
    const ready = await waitForPrompts(client, recorded, folderExists);
    const { busy, failed } = await busyVerdicts(client, ready.plan);
    const panes = ready.panes.map((pane) => ({ ...pane, busy: busy.get(pane.paneId) }));
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
  };

  const runReturn = async (): Promise<void> => {
    if (returning) return;
    returning = true;
    try {
      await returnPanes();
    } catch (err: unknown) {
      log("warn", `cwd-return: failed: ${errorText(err)}`);
    } finally {
      returning = false;
    }
  };

  // The first snapshot of this activation is checked for freshly restored shells before it may touch the record.
  const handleSnapshot = (snapshot: SessionSnapshot, pipeName: string): void => {
    if (activationPending && deps.holdsLease()) {
      activationPending = false;
      const panes = snapshot.panes.map(({ pane_id, cwd }) => ({ paneId: pane_id, rawCwd: cwd }));
      if (isRestart({ kind: "connected", panes, recordedPaneIds: new Set(Object.keys(load(pipeName).panes)) })) {
        void runReturn();
        return;
      }
    }
    if (recordingAllowed()) merge(snapshot, pipeName);
  };

  const poll = async (): Promise<void> => {
    if (!recordingAllowed()) return;
    try {
      const pipeName = deps.pipeName();
      const snapshot = await deps.client(pipeName).snapshot();
      if (!returning) handleSnapshot(snapshot, pipeName);
    } catch (err: unknown) {
      log("warn", `cwd-return: record poll failed: ${errorText(err)}`);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => void poll().finally(schedule), RECORD_POLL_MS);
  };

  return {
    start: () => {
      stopped = false;
      clock.clearTimeout(timer);
      schedule();
    },
    stop: () => {
      stopped = true;
      clock.clearTimeout(timer);
    },
    poll,
    observeSnapshot: (snapshot) => {
      if (returning) return;
      try {
        handleSnapshot(snapshot, deps.pipeName());
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
        const parsed: unknown = JSON.parse(text);
        if (isCwdRecord(parsed) && parsed.key === key) return parsed;
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
