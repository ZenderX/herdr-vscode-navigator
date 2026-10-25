import type { Logger } from "../herdr/types";

export type CwdOrigin = "probe" | "foreground_cwd" | "cwd";

export type ProbeResult = { ok: true; path: string } | { ok: false; reason: string };

export interface ProbeSettings {
  enabled: boolean;
  /** Windows only: path to Git for Windows' usr\bin\bash.exe. Empty string means auto-detect. */
  gitBashPath: string;
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  readlink(path: string): Promise<string>;
  /** Rejects on non-zero exit (error `code` carries the exit code), timeout, or spawn failure. */
  execFile(file: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string }>;
  exists(path: string): boolean;
  isDirectory(path: string): Promise<boolean>;
  /** Receives the one-time note when a system tool is not at its absolute path. */
  log?: Logger;
  /** Milliseconds clock for memo expiry; defaults to Date.now. */
  now?(): number;
}

/** A pane and the herdr `shell_pid` (a Windows pid) of its shell. */
export interface ShellPane {
  paneId: string;
  shellPid: number;
}

/** A live folder read from the pane's MSYS shell `/proc/<pid>/cwd`, as a Windows path. */
export interface MsysCwd {
  cwd: string;
  source: "msys";
}

/** pane id -> live folder, or undefined when the pane has no unambiguous MSYS bash shell (never a guess). */
export type MsysCwdBatch = ReadonlyMap<string, MsysCwd | undefined>;

export interface FailedAttempt {
  source: CwdOrigin;
  reason: string;
}

export interface ResolvedCwd {
  path: string | null;
  source: CwdOrigin | null;
  /** Sources tried before the winning one (or all of them when none won), in order, with why each failed. */
  attempts: FailedAttempt[];
}
