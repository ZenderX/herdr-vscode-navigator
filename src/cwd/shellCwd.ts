import { normalizeCwd } from "../paths";
import { createToolResolver } from "../toolPaths";
import type { Tool } from "../toolPaths";
import { findGitBash } from "./gitBash";
import type { MsysCwd, MsysCwdBatch, ProbeDeps, ProbeResult, ShellPane } from "./types";

// Measured 2026-10-24 on Windows 11, Git for Windows 2.46.2: warm single-pid bash.exe run ~56 ms, PowerShell CIM child lookup ~280-590 ms.
// herdr 0.9.5 reports shell_pid as a Windows PID. For Git Bash that is the native launcher Git\bin\bash.exe
// (no MSYS /proc entry, `ps -W` shows PPID 0); the real MSYS shell is its Windows child (usr\bin\bash.exe, PPID 1 in MSYS terms).
// So: try shell_pid in MSYS /proc, else try only its direct Windows children; deeper MSYS processes (a bash tool, ssh, less under a native shell) are not the pane's shell.
const BASH_TIMEOUT_MS = 3000;
const POWERSHELL_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 3000;

// Args are Windows pids; exit 1 when none has an MSYS /proc entry, exit 2 when a tool is missing or fails. First pid in argument order wins.
// A non-login bash started from a native process lacks /usr/bin on PATH, so PATH is set first and winpid is read with the `read` builtin.
const MSYS_CWD_SCRIPT =
  'PATH=/usr/bin:$PATH; [ -x /usr/bin/readlink ] && [ -x /usr/bin/cygpath ] || exit 2; for w in "$@"; do for f in /proc/[0-9]*/winpid; do v=; { read -r v < "$f"; } 2>/dev/null; if [ "$v" = "$w" ]; then d=$(readlink "${f%/winpid}/cwd") || exit 2; cygpath -w "$d" || exit 2; exit 0; fi; done; done; exit 1';

// Prints the Windows pids of the direct children of $root.
export const CHILDREN_SCRIPT =
  "& { param([int]$root) Get-CimInstance Win32_Process -Filter \"ParentProcessId=$root\" | ForEach-Object { $_.ProcessId } }";

// Prints every MSYS bash's Windows pid, then each one's cwd in the same order; builtins only per /proc entry (~50 ms for any count, a $(...) each costs seconds).
// cd -P pairs pid and folder inside the loop and hands cygpath resolved folders, since a vanished pid aborts a multi-arg cygpath of /proc links.
const MSYS_SHELLS_SCRIPT =
  'PATH=/usr/bin:$PATH; [ -x /usr/bin/cygpath ] || exit 2; W=(); D=(); for f in /proc/[0-9]*; do w=; e=; { read -r w < "$f/winpid"; read -r e < "$f/exename"; } 2>/dev/null; [ -n "$w" ] && [ "$e" = /usr/bin/bash ] || continue; cd -P "$f/cwd" 2>/dev/null || continue; W+=("$w"); D+=("$PWD"); done; [ ${#W[@]} -gt 0 ] || exit 0; printf \'%s\\n\' "${W[@]}"; exec cygpath -w "${D[@]}"';

// Args are Windows pids; prints "<parent> <child>" for every direct child of any of them, in one CIM query.
const CHILD_PAIRS_SCRIPT =
  "& { $f = ($args | ForEach-Object { 'ParentProcessId=' + $_ }) -join ' OR '; Get-CimInstance Win32_Process -Filter $f | ForEach-Object { [string]$_.ParentProcessId + ' ' + $_.ProcessId } }";

const NOT_MSYS = "not an MSYS process";

const fail = (reason: string): ProbeResult => ({ ok: false, reason });

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function exitCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** Extracts the cwd path from `lsof -Fn` output (`p<pid>`, `fcwd`, `n<path>`). */
function parseLsofCwd(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("n"));
  return line && line.length > 1 ? line.slice(1) : null;
}

/** Returns the absolute, existing directory for a raw probe output, or a failure. */
async function accept(raw: string | null, deps: ProbeDeps): Promise<ProbeResult> {
  const trimmed = raw?.trim();
  if (!trimmed) return fail("probe returned no directory");
  const path = normalizeCwd(trimmed, deps.platform);
  if (path === null) return fail(`probe returned a non-absolute path: ${trimmed}`);
  if (!(await deps.isDirectory(path))) return fail(`directory does not exist: ${path}`);
  return { ok: true, path };
}

// Session memo: a pane's launcher and its MSYS shell child do not change, so discovery runs once per shell_pid.
interface WindowsMemo {
  bashPath?: string;
  /** The gitBashPath setting the cached bashPath was computed for. */
  bashSetting?: string;
  /** shell_pid -> Windows pids to hand to the bash read (the pid itself or its descendants). */
  winpids: Map<number, string[]>;
  /** shell_pid -> expiry time; PIDs get reused and launchers spawn their MSYS child late. */
  notMsys: Map<number, number>;
}

const NOT_MSYS_TTL_MS = 30_000;

// execFile marks a timed-out child as killed.
const timedOut = (error: unknown): boolean => typeof error === "object" && error !== null && "killed" in error && error.killed === true;

async function probeWindows(
  pid: number,
  gitBashPath: string,
  deps: ProbeDeps,
  memo: WindowsMemo,
  resolveTool: (tool: Tool) => string,
): Promise<ProbeResult> {
  if (memo.bashSetting !== gitBashPath) {
    memo.bashPath = findGitBash(gitBashPath, deps);
    memo.bashSetting = gitBashPath;
  } else {
    memo.bashPath ??= findGitBash(gitBashPath, deps);
  }
  const bash = memo.bashPath;
  if (!bash) return fail("Git Bash not found");
  const now = (deps.now ?? Date.now)();
  const notMsysUntil = memo.notMsys.get(pid);
  if (notMsysUntil !== undefined) {
    if (now < notMsysUntil) return fail(NOT_MSYS);
    memo.notMsys.delete(pid);
  }
  const markNotMsys = (): ProbeResult => {
    memo.notMsys.set(pid, now + NOT_MSYS_TTL_MS);
    return fail(NOT_MSYS);
  };

  const runBash = (pids: readonly string[]): Promise<{ stdout: string }> =>
    deps.execFile(bash, ["-c", MSYS_CWD_SCRIPT, "_", ...pids], BASH_TIMEOUT_MS);

  const mapped = memo.winpids.get(pid);
  if (mapped) {
    try {
      return await accept((await runBash(mapped)).stdout, deps);
    } catch (error: unknown) {
      // A timeout says nothing about the mapping; rediscovery would only stack more waits on this cycle.
      if (timedOut(error)) return fail(`bash probe failed: ${describe(error)}`);
      // The mapped process is gone or unreadable: forget it and rediscover below.
      memo.winpids.delete(pid);
    }
  }

  try {
    const result = await accept((await runBash([String(pid)])).stdout, deps);
    memo.winpids.set(pid, [String(pid)]);
    return result;
  } catch (error: unknown) {
    if (exitCode(error) !== 1) return fail(`bash probe failed: ${describe(error)}`);
  }

  let descendants: string[];
  try {
    const { stdout } = await deps.execFile(
      resolveTool("powershell"),
      ["-NoProfile", "-NonInteractive", "-Command", CHILDREN_SCRIPT, String(pid)],
      POWERSHELL_TIMEOUT_MS,
    );
    descendants = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch (error: unknown) {
    return fail(`descendant lookup failed: ${describe(error)}`);
  }
  if (descendants.length === 0) return markNotMsys();

  try {
    const result = await accept((await runBash(descendants)).stdout, deps);
    memo.winpids.set(pid, descendants);
    return result;
  } catch (error: unknown) {
    if (exitCode(error) !== 1) return fail(`bash probe failed: ${describe(error)}`);
    return markNotMsys();
  }
}

/** Returns a probe of a shell pid's live cwd for the injected platform; the probe never throws. */
export function createShellCwdProbe(deps: ProbeDeps): (pid: number, gitBashPath: string) => Promise<ProbeResult> {
  const memo: WindowsMemo = { winpids: new Map(), notMsys: new Map() };
  const resolveTool = createToolResolver(deps);

  return async (pid, gitBashPath) => {
    if (!Number.isInteger(pid) || pid <= 0) return fail(`invalid shell pid: ${pid}`);
    try {
      switch (deps.platform) {
        case "linux":
          return await accept(await deps.readlink(`/proc/${pid}/cwd`), deps);
        case "darwin": {
          const { stdout } = await deps.execFile(resolveTool("lsof"), ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], LSOF_TIMEOUT_MS);
          return await accept(parseLsofCwd(stdout), deps);
        }
        case "win32":
          return await probeWindows(pid, gitBashPath, deps, memo, resolveTool);
        default:
          return fail(`unsupported platform: ${deps.platform}`);
      }
    } catch (error: unknown) {
      return fail(describe(error));
    }
  };
}

/** Windows pid -> cwd from MSYS_SHELLS_SCRIPT output; throws when pids and folders do not pair up. */
function parseMsysShells(stdout: string): Map<number, string> {
  const lines = stdout.split(/\r?\n/).filter((line) => line !== "");
  const half = lines.length / 2;
  if (!Number.isInteger(half)) throw new Error(`MSYS shell scan printed ${lines.length} lines, not pid/folder pairs`);
  const shells = new Map<number, string>();
  for (let i = 0; i < half; i++) {
    const pid = lines[i];
    if (!/^\d+$/.test(pid)) throw new Error(`MSYS shell scan printed a non-numeric pid: ${pid}`);
    shells.set(Number(pid), lines[half + i]);
  }
  return shells;
}

export type MsysBatchProbe = (panes: readonly ShellPane[], gitBashPath: string) => Promise<MsysCwdBatch>;

/**
 * Reads the live folder of many Windows Git Bash panes with one MSYS scan; rejects when Git Bash is missing or a lookup fails.
 * Concurrent calls share one in-flight scan and one CIM lookup per new shell_pid. Off Windows every pane maps to undefined.
 */
export function createMsysBatchProbe(deps: ProbeDeps): MsysBatchProbe {
  const resolveTool = createToolResolver(deps);
  // A launcher's single MSYS bash child does not change, so a resolved shell_pid skips CIM until that shell is gone.
  const innerOf = new Map<number, number>();
  const lookups = new Map<number, Promise<number[]>>();
  let scanning: Promise<Map<number, string>> | undefined;
  let bashFor: { setting: string; path: string | undefined } | undefined;

  const locateBash = (setting: string): string | undefined => {
    if (bashFor?.setting !== setting) bashFor = { setting, path: findGitBash(setting, deps) };
    return bashFor.path;
  };

  const scan = (bash: string): Promise<Map<number, string>> => {
    scanning ??= deps
      .execFile(bash, ["-c", MSYS_SHELLS_SCRIPT], BASH_TIMEOUT_MS)
      .then(({ stdout }) => parseMsysShells(stdout), (error: unknown) => Promise.reject(new Error(`MSYS shell scan failed: ${describe(error)}`)))
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  };

  const childPairs = async (pids: readonly number[]): Promise<Map<number, number[]>> => {
    let stdout: string;
    try {
      ({ stdout } = await deps.execFile(
        resolveTool("powershell"),
        ["-NoProfile", "-NonInteractive", "-Command", CHILD_PAIRS_SCRIPT, ...pids.map(String)],
        POWERSHELL_TIMEOUT_MS,
      ));
    } catch (error: unknown) {
      throw new Error(`child lookup failed: ${describe(error)}`);
    }
    const children = new Map<number, number[]>(pids.map((pid) => [pid, []]));
    for (const line of stdout.split(/\r?\n/)) {
      const pair = /^(\d+) (\d+)$/.exec(line.trim());
      if (pair) children.get(Number(pair[1]))?.push(Number(pair[2]));
    }
    return children;
  };

  const childrenOf = (pids: readonly number[]): Promise<number[][]> => {
    const fresh = pids.filter((pid) => !lookups.has(pid));
    if (fresh.length > 0) {
      const batch = childPairs(fresh);
      for (const pid of fresh) {
        const one = batch.then((children) => children.get(pid) ?? []).finally(() => lookups.delete(pid));
        lookups.set(pid, one);
      }
    }
    return Promise.all(pids.map((pid) => lookups.get(pid) ?? Promise.resolve([])));
  };

  return async (panes, gitBashPath) => {
    const result = new Map<string, MsysCwd | undefined>(panes.map(({ paneId }) => [paneId, undefined]));
    if (deps.platform !== "win32") return result;
    const bash = locateBash(gitBashPath);
    if (!bash) throw new Error("Git Bash not found");
    const shells = await scan(bash);

    // A shell_pid that is itself an MSYS bash (herdr default_shell = usr\bin\bash.exe) has no launcher in between.
    const winpidOf = (shellPid: number): number | undefined => {
      if (shells.has(shellPid)) return shellPid;
      const inner = innerOf.get(shellPid);
      if (inner !== undefined && shells.has(inner)) return inner;
      innerOf.delete(shellPid);
      return undefined;
    };
    const valid = panes.filter(({ shellPid }) => Number.isInteger(shellPid) && shellPid > 0);
    const unresolved = [...new Set(valid.map(({ shellPid }) => shellPid).filter((pid) => winpidOf(pid) === undefined))];
    if (unresolved.length > 0) {
      const children = await childrenOf(unresolved);
      unresolved.forEach((pid, index) => {
        const msys = children[index].filter((child) => shells.has(child));
        // Zero or several MSYS bash children is ambiguous: the pane gets no folder rather than another shell's.
        if (msys.length === 1) innerOf.set(pid, msys[0]);
      });
    }

    for (const { paneId, shellPid } of valid) {
      const winpid = winpidOf(shellPid);
      const path = normalizeCwd(winpid === undefined ? undefined : shells.get(winpid), "win32");
      if (path !== null && (await deps.isDirectory(path))) result.set(paneId, { cwd: path, source: "msys" });
    }
    return result;
  };
}
