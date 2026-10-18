import { posix, win32 } from "node:path";

const MSYS_DRIVE = /^\\(?:cygdrive\\)?([a-zA-Z])(?:\\(.*))?$/;
const WIN_DRIVE = /^([a-zA-Z]):\\(.*)$/;
const UNC = /^\\\\[^\\]+\\[^\\]+/;

function stripTrailingSeparator(path: string): string {
  if (/^[A-Z]:\\$/.test(path)) return path;
  return path.replace(/\\+$/, "");
}

function normalizeWindows(trimmed: string): string | null {
  const backslashed = trimmed.replace(/\//g, "\\");

  let candidate: string;
  const winDrive = WIN_DRIVE.exec(backslashed);
  const msysDrive = MSYS_DRIVE.exec(backslashed);
  if (winDrive?.[1] !== undefined) {
    candidate = `${winDrive[1].toUpperCase()}:\\${winDrive[2] ?? ""}`;
  } else if (msysDrive?.[1] !== undefined) {
    candidate = `${msysDrive[1].toUpperCase()}:\\${msysDrive[2] ?? ""}`;
  } else if (UNC.test(backslashed)) {
    candidate = backslashed;
  } else {
    return null;
  }

  return stripTrailingSeparator(win32.normalize(candidate));
}

function normalizePosix(trimmed: string): string | null {
  if (!trimmed.startsWith("/")) return null;
  const normalized = posix.normalize(trimmed);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

/**
 * Converts any cwd string herdr may report into an absolute path for `platform`, or null.
 */
export function normalizeCwd(input: string | null | undefined, platform: NodeJS.Platform): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  return platform === "win32" ? normalizeWindows(trimmed) : normalizePosix(trimmed);
}

/**
 * Comparison of two cwd strings after normalization.
 * Windows and macOS volumes are case-insensitive by default, Linux is case-sensitive.
 */
export function samePath(
  a: string | null | undefined,
  b: string | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  const left = normalizeCwd(a, platform);
  const right = normalizeCwd(b, platform);
  if (left === null || right === null) return false;
  if (platform === "linux") return left === right;
  return left.toLowerCase() === right.toLowerCase();
}
