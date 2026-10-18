import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;
export type Probe = (path: string) => Promise<boolean>;

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function readEnv(env: Env, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const match = Object.keys(env).find((k) => k.toUpperCase() === key);
  return match === undefined ? undefined : env[match];
}

// Ordered absolute candidate paths for `name` across PATH; never throws on a missing PATH.
export function executableCandidates(name: string, env: Env, platform: NodeJS.Platform): string[] {
  const isWin = platform === "win32";
  const rawPath = readEnv(env, "PATH", platform);
  if (!rawPath) return [];

  const join = isWin ? win32.join : posix.join;
  const dirs = rawPath
    .split(isWin ? ";" : ":")
    .map((dir) => (isWin ? dir.replace(/^"(.*)"$/, "$1") : dir))
    .filter((dir) => dir.length > 0);
  const names = [name];
  if (isWin) {
    const exts = (readEnv(env, "PATHEXT", platform) || DEFAULT_PATHEXT).split(";").filter((ext) => ext.length > 0);
    names.unshift(...exts.map((ext) => name + ext.toLowerCase()));
  }
  return dirs.flatMap((dir) => names.map((file) => join(dir, file)));
}

function defaultProbe(platform: NodeJS.Platform): Probe {
  const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
  return async (path) => {
    try {
      await access(path, mode);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
}

export async function resolveOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: Env,
  probe: Probe = defaultProbe(platform),
): Promise<string | undefined> {
  for (const candidate of executableCandidates(name, env, platform)) {
    if (await probe(candidate)) return candidate;
  }
  return undefined;
}
