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
  /** Milliseconds clock for memo expiry; defaults to Date.now. */
  now?(): number;
}

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
