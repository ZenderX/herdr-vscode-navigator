import { dirname as posixDirname, join as posixJoin } from "node:path/posix";
import { dirname as winDirname, join as winJoin } from "node:path/win32";
import { samePath } from "../paths";

const PIPE_PREFIX = "\\\\.\\pipe\\";

/** The default session's socket sits beside its session.json; this is that socket without any pipe prefix. */
export function defaultSocketBeside(sessionFilePath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? winJoin(winDirname(sessionFilePath), "herdr.sock") : posixJoin(posixDirname(sessionFilePath), "herdr.sock");
}

/** The pipe name or socket path to connect to for the default session, given the located session.json. */
export function defaultSocketName(sessionFilePath: string, platform: NodeJS.Platform): string {
  const socket = defaultSocketBeside(sessionFilePath, platform);
  return platform === "win32" ? PIPE_PREFIX + socket : socket;
}

/** True when the socket the client uses belongs to the default session whose session.json was located. */
export function isDefaultSessionSocket(sessionFilePath: string, socketName: string, platform: NodeJS.Platform): boolean {
  const bare = platform === "win32" && socketName.startsWith(PIPE_PREFIX) ? socketName.slice(PIPE_PREFIX.length) : socketName;
  return samePath(bare, defaultSocketBeside(sessionFilePath, platform), platform);
}
