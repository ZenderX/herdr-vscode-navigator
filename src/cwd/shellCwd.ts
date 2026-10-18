import { normalizeCwd } from "../paths";
import { findGitBash } from "./gitBash";
import type { ProbeDeps, ProbeResult } from "./types";

// Measured 2026-10-17 on Windows 11, Git for Windows 2.x: warm bash.exe run ~110 ms, PowerShell CIM descendant scan ~590 ms.
// herdr 0.9.5 reports shell_pid as a Windows PID. For Git Bash that is the native launcher Git\bin\bash.exe
// (no MSYS /proc entry, `ps -W` shows PPID 0); the real MSYS shell is its Windows child (usr\bin\bash.exe, PPID 1 in MSYS terms).
// So: try shell_pid in MSYS /proc, else try only its direct Windows children; deeper MSYS processes (a bash tool, ssh, less under a native shell) are not the pane's shell.
const BASH_TIMEOUT_MS = 3000;
const POWERSHELL_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 3000;

// Args are Windows pids; exit 1 when none has an MSYS /proc entry, exit 2 when a tool is missing or fails. First pid in argument order wins.
// A non-login bash started from a native process lacks /usr/bin on PATH, so PATH is set first and winpid is read with the `read` builtin.
export const MSYS_CWD_SCRIPT =
  'PATH=/usr/bin:$PATH; [ -x /usr/bin/readlink ] && [ -x /usr/bin/cygpath ] || exit 2; for w in "$@"; do for f in /proc/[0-9]*/winpid; do v=; { read -r v < "$f"; } 2>/dev/null; if [ "$v" = "$w" ]; then d=$(readlink "${f%/winpid}/cwd") || exit 2; cygpath -w "$d" || exit 2; exit 0; fi; done; done; exit 1';

// Prints the Windows pids of the direct children of $root.
const CHILDREN_SCRIPT =
  "& { param([int]$root) Get-CimInstance Win32_Process -Filter \"ParentProcessId=$root\" | ForEach-Object { $_.ProcessId } }";

const NOT_MSYS = "not an MSYS process";

const fail = (reason: string): ProbeResult => ({ ok: false, reason });

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function exitCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** Extracts the cwd path from `lsof -Fn` output (`p<pid>`, `fcwd`, `n<path>`). */
export function parseLsofCwd(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("n"));
  return line && line.length > 1 ? line.slice(1) : null;
}

/** Absolute, normalised path without a trailing separator, or null; Windows forms on win32, POSIX elsewhere. */
export function normalizeForPlatform(raw: string | null | undefined, platform: NodeJS.Platform): string | null {
  return normalizeCwd(raw, platform);
}

/** Returns the absolute, existing directory for a raw probe output, or a failure. */
async function accept(raw: string | null, deps: ProbeDeps): Promise<ProbeResult> {
  const trimmed = raw?.trim();
  if (!trimmed) return fail("probe returned no directory");
  const path = normalizeForPlatform(trimmed, deps.platform);
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

async function probeWindows(pid: number, gitBashPath: string, deps: ProbeDeps, memo: WindowsMemo): Promise<ProbeResult> {
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
      "powershell.exe",
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

  return async (pid, gitBashPath) => {
    if (!Number.isInteger(pid) || pid <= 0) return fail(`invalid shell pid: ${pid}`);
    try {
      switch (deps.platform) {
        case "linux":
          return await accept(await deps.readlink(`/proc/${pid}/cwd`), deps);
        case "darwin": {
          const { stdout } = await deps.execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], LSOF_TIMEOUT_MS);
          return await accept(parseLsofCwd(stdout), deps);
        }
        case "win32":
          return await probeWindows(pid, gitBashPath, deps, memo);
        default:
          return fail(`unsupported platform: ${deps.platform}`);
      }
    } catch (error: unknown) {
      return fail(describe(error));
    }
  };
}
