import { posix, win32 } from "node:path";

export const SESSION_FILE_VERSION = 3;

export interface SessionPane {
  cwd: string;
  agent_session?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionTab {
  panes: Record<string, SessionPane>;
  [key: string]: unknown;
}

export interface SessionWorktreeSpace {
  repo_root?: unknown;
  [key: string]: unknown;
}

export interface SessionWorkspace {
  id: string;
  identity_cwd: string;
  worktree_space?: SessionWorktreeSpace;
  tabs: SessionTab[];
  [key: string]: unknown;
}

export interface SessionData {
  version: 3;
  workspaces: SessionWorkspace[];
  [key: string]: unknown;
}

export interface LoadedSessionFile {
  path: string;
  session: SessionData;
}

export type ParseResult = { ok: true; session: SessionData } | { ok: false; reason: string };

export type SessionPathResult = { kind: "path"; path: string } | { kind: "unsupported"; reason: string };

export interface PathEnv {
  get(name: string): string | undefined;
  homeDir(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPane(value: unknown): string | null {
  if (!isRecord(value)) return "pane is not an object";
  if (typeof value["cwd"] !== "string") return "pane cwd is not a string";
  const agent = value["agent_session"];
  if (agent !== undefined && !isRecord(agent)) return "pane agent_session is not an object";
  return null;
}

function checkTab(value: unknown): string | null {
  if (!isRecord(value)) return "tab is not an object";
  const panes = value["panes"];
  if (!isRecord(panes)) return "tab panes is not an object";
  for (const pane of Object.values(panes)) {
    const problem = checkPane(pane);
    if (problem) return problem;
  }
  return null;
}

function checkWorkspace(value: unknown): string | null {
  if (!isRecord(value)) return "workspace is not an object";
  if (typeof value["id"] !== "string") return "workspace id is not a string";
  if (typeof value["identity_cwd"] !== "string") return "workspace identity_cwd is not a string";
  const worktree = value["worktree_space"];
  if (worktree !== undefined && !isRecord(worktree)) return "workspace worktree_space is not an object";
  const tabs = value["tabs"];
  if (!Array.isArray(tabs)) return "workspace tabs is not an array";
  for (const tab of tabs) {
    const problem = checkTab(tab);
    if (problem) return problem;
  }
  return null;
}

/**
 * Validates a parsed session.json against schema version 3. Unknown extra fields are accepted
 * and stay on the returned object, so a rewrite serialises everything herdr wrote.
 */
export function validateSession(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, reason: "session file is not an object" };
  if (value["version"] !== SESSION_FILE_VERSION) {
    return { ok: false, reason: `unsupported session file version ${JSON.stringify(value["version"])}` };
  }
  const workspaces = value["workspaces"];
  if (!Array.isArray(workspaces)) return { ok: false, reason: "workspaces is not an array" };
  for (const workspace of workspaces) {
    const problem = checkWorkspace(workspace);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, session: value as SessionData };
}

export function parseSessionFile(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return { ok: false, reason: `session file is not valid JSON: ${detail}` };
  }
  return validateSession(parsed);
}

/**
 * Locates herdr's default-session session.json. Named sessions and a config-path override use
 * layouts herdr does not document, so they are reported as unsupported rather than guessed.
 */
export function resolveSessionFilePath(platform: NodeJS.Platform, env: PathEnv): SessionPathResult {
  if (env.get("HERDR_SESSION")) return { kind: "unsupported", reason: "HERDR_SESSION is set" };
  if (env.get("HERDR_CONFIG_PATH")) return { kind: "unsupported", reason: "HERDR_CONFIG_PATH is set" };

  if (platform === "win32") {
    const appData = env.get("APPDATA");
    if (!appData) return { kind: "unsupported", reason: "APPDATA is not set" };
    return { kind: "path", path: win32.join(appData, "herdr", "session.json") };
  }

  const xdg = env.get("XDG_CONFIG_HOME");
  const configDir = xdg ? xdg : posix.join(env.homeDir(), ".config");
  return { kind: "path", path: posix.join(configDir, "herdr", "session.json") };
}
