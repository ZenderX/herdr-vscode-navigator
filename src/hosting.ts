import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Compared without a ".exe" suffix so the Windows and POSIX process names both match.
const HERDR_PROCESS = "herdr";
const PROCESS_TABLE_COMMAND =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine?: string;
}

/** Parses Get-CimInstance JSON; a single process serializes as an object, not an array. */
export function parseProcessTable(json: string): ProcessInfo[] {
  const parsed: unknown = JSON.parse(json);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const table: ProcessInfo[] = [];
  for (const row of rows as (Record<string, unknown> | null)[]) {
    if (row === null) continue;
    const { ProcessId: pid, ParentProcessId: ppid, Name: name } = row;
    if (typeof pid === "number" && typeof ppid === "number" && typeof name === "string") {
      const { CommandLine: commandLine } = row;
      table.push(typeof commandLine === "string" ? { pid, ppid, name, commandLine } : { pid, ppid, name });
    }
  }
  return table;
}

/** A parent link between two Windows pids taken from the MSYS process graph. */
export interface MsysEdge {
  child: number;
  parent: number;
}

/**
 * Parses Git for Windows `ps -W` rows (`PID PPID PGID WINPID TTY UID STIME COMMAND`) into Windows-pid edges.
 * Columns are read positionally because STIME and COMMAND may contain spaces.
 */
export function parseMsysTable(text: string): MsysEdge[] {
  const rows: { pid: number; ppid: number; winpid: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[A-Za-z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), winpid: Number(match[4]) });
  }
  const winpidOf = new Map(rows.map(({ pid, winpid }) => [pid, winpid]));
  const edges: MsysEdge[] = [];
  for (const { ppid, winpid } of rows) {
    const parent = winpidOf.get(ppid);
    if (parent !== undefined && parent !== winpid) edges.push({ child: winpid, parent });
  }
  return edges;
}

/**
 * Parses `ps -A -o pid=,ppid=,args=` rows. `commandLine` holds the arguments after the executable so that
 * the `server` subcommand check ignores directory names in the executable path.
 */
export function parsePsTable(text: string): ProcessInfo[] {
  const table: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, executable = "", args] = match;
    const name = executable.slice(executable.lastIndexOf("/") + 1);
    table.push({ pid: Number(pid), ppid: Number(ppid), name, ...(args ? { commandLine: args } : {}) });
  }
  return table;
}

export type HostState = "yes" | "no" | "unknown";

// MSYS forks leave these behind with a dead Windows parent.
const MSYS_LAYER = new Set(["env.exe", "bash.exe", "sh.exe", "herdr.exe"]);

/**
 * "yes" when a herdr client descends from a terminal shell over the union of Windows and MSYS parent links.
 * "unknown" when no client reaches a shell and some MSYS-launched client's chain dies at a missing pid,
 * so the link may be hidden; otherwise "no".
 */
export function classifyHosting(
  table: readonly ProcessInfo[],
  shellPids: readonly number[],
  msysEdges: readonly MsysEdge[] = [],
): HostState {
  const shells = new Set(shellPids);
  if (shells.size === 0) return "no";
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const parents = new Map<number, number[]>();
  const link = (child: number, parent: number): void => {
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  };
  for (const { pid, ppid } of table) link(pid, ppid);
  for (const { child, parent } of msysEdges) link(child, parent);
  const msysChildren = new Set(msysEdges.map(({ child }) => child));

  const clients = table.filter(
    ({ name, commandLine }) => name.toLowerCase().replace(/\.exe$/, "") === HERDR_PROCESS && !/\bserver\b/.test(commandLine ?? ""),
  );
  let broken = false;
  for (const { pid } of clients) {
    // The visited set guards against parent loops caused by pid reuse.
    const seen = new Set<number>();
    const stack = [pid];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (seen.has(current)) continue;
      seen.add(current);
      if (shells.has(current)) return "yes";
      for (const parent of parents.get(current) ?? []) {
        stack.push(parent);
        const info = byPid.get(current);
        if (!byPid.has(parent) && info && MSYS_LAYER.has(info.name.toLowerCase()) && !msysChildren.has(pid)) {
          broken = true;
        }
      }
    }
  }
  return broken ? "unknown" : "no";
}

/** Whether automatic plans of any kind may run: a hosting window, or an undetectable one the user confirmed. */
export function mayFollowAutomatically(state: HostState, confirmedHere: boolean | undefined): boolean {
  return state === "yes" || (state === "unknown" && confirmedHere === true);
}

/** Resolves with `undefined` when the promise has not settled within `ms`. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface CachedScan<T> {
  /** Resolves a cached result while fresh; `force` skips the cache but still joins an in-flight scan. */
  get(force?: boolean): Promise<T>;
}

/** Caches an async scan with a per-result lifetime and coalesces concurrent requests into one run. */
export function createCachedScan<T>(
  scan: () => Promise<T>,
  ttlMs: (value: T) => number,
  now: () => number = Date.now,
): CachedScan<T> {
  let cached: { value: T; at: number } | undefined;
  let inflight: Promise<T> | undefined;
  return {
    get(force = false): Promise<T> {
      if (inflight) return inflight;
      if (!force && cached && now() - cached.at < ttlMs(cached.value)) return Promise.resolve(cached.value);
      inflight = scan()
        .then((value) => {
          cached = { value, at: now() };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}

/** Finds Git for Windows' ps.exe next to a git.exe on PATH (cmd\ or bin\ layouts) or in Program Files. */
function findMsysPs(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = dirs
    .filter((dir) => existsSync(path.join(dir, "git.exe")))
    .flatMap((dir) => [path.join(dir, "..", "usr", "bin", "ps.exe"), path.join(dir, "..", "..", "usr", "bin", "ps.exe")]);
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "Git", "usr", "bin", "ps.exe"));
  return candidates.find((candidate) => existsSync(candidate));
}

async function readMsysEdges(): Promise<MsysEdge[]> {
  const ps = findMsysPs();
  if (!ps) return [];
  try {
    const { stdout } = await execFileAsync(ps, ["-W"], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true });
    return parseMsysTable(stdout);
  } catch {
    // Without MSYS links, classifyHosting degrades to "unknown" for MSYS-launched herdr.
    return [];
  }
}

export async function readProcessTable(platform: NodeJS.Platform): Promise<{ table: ProcessInfo[]; msysEdges: MsysEdge[] }> {
  if (platform !== "win32") {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,args="], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
    return { table: parsePsTable(stdout), msysEdges: [] };
  }
  const [{ stdout }, msysEdges] = await Promise.all([
    execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_TABLE_COMMAND], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    }),
    readMsysEdges(),
  ]);
  return { table: parseProcessTable(stdout), msysEdges };
}
