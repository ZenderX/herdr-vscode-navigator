import * as path from "node:path";

const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * Override > HERDR_SOCKET_PATH > default location.
 * Windows: `%APPDATA%\herdr\herdr.sock`, prefixed as a named pipe (herdr-sidebar `ipc.rs` `socket_path()`).
 * Linux/macOS: the Unix domain socket `~/.config/herdr/herdr.sock` (herdr docs, https://herdr.dev/docs/socket-api "Socket paths";
 * named sessions use `~/.config/herdr/sessions/<name>/herdr.sock` and need `HERDR_SOCKET_PATH`).
 * The herdr-sidebar reference client has no non-Windows default, so the docs are the only source for it.
 */
export function resolvePipeName(override: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const explicit = override?.trim() || env.HERDR_SOCKET_PATH?.trim();
  if (platform === "win32") {
    const marker = explicit || (env.APPDATA ? path.win32.join(env.APPDATA, "herdr", "herdr.sock") : "");
    if (!marker) {
      throw new Error("Cannot resolve herdr socket path: set herdrNavigator.socketPath or HERDR_SOCKET_PATH");
    }
    return marker.startsWith(PIPE_PREFIX) ? marker : PIPE_PREFIX + marker;
  }
  const socket = explicit || (env.HOME ? path.posix.join(env.HOME, ".config", "herdr", "herdr.sock") : "");
  if (!socket) {
    throw new Error("Cannot resolve herdr socket path: set herdrNavigator.socketPath or HERDR_SOCKET_PATH");
  }
  return socket;
}
