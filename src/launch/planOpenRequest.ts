import type { OpenRequestResult } from "../uri/openRequest";

const DEFAULT_TERMINAL_NAME = "herdr";

export type OpenPlan =
  | { action: "reject"; reason: string }
  | { action: "herdr-missing" }
  | { action: "reveal"; terminalIndex: number; focusArgs: string[] }
  | { action: "create"; name: string; shellPath: string; shellArgs: string[]; focusArgs: string[] };

export interface OpenPlanInput {
  request: OpenRequestResult;
  /** The window's terminals in `window.terminals` order; `live` means a herdr client is known to run in it ("unknown" counts as not live). */
  terminals: readonly { name: string; live: boolean }[];
  herdrPath: string | undefined;
}

export function terminalNameFor(session: string | undefined): string {
  return session === undefined ? DEFAULT_TERMINAL_NAME : `${DEFAULT_TERMINAL_NAME} (${session})`;
}

// `--session` goes before the subcommand; it is the only thing that selects a session for `workspace` commands.
function focusArgsFor(spaceId: string, session: string | undefined): string[] {
  return [...(session === undefined ? [] : ["--session", session]), "workspace", "focus", spaceId];
}

/** Request values only ever land in argv elements, never in shell text. */
export function planOpenRequest({ request, terminals, herdrPath }: OpenPlanInput): OpenPlan {
  if (!request.ok) return { action: "reject", reason: request.reason };
  const { spaceId, session } = request;
  const focusArgs = focusArgsFor(spaceId, session);
  const name = terminalNameFor(session);
  // A terminal named like ours but without a live client is a bare shell; revealing it would strand the user.
  const terminalIndex = terminals.findIndex((terminal) => terminal.name === name && terminal.live);
  if (terminalIndex >= 0) return { action: "reveal", terminalIndex, focusArgs };
  if (herdrPath === undefined) return { action: "herdr-missing" };
  return { action: "create", name, shellPath: herdrPath, shellArgs: session === undefined ? [] : ["--session", session], focusArgs };
}

const isHerdrVar = (key: string): boolean => key.toUpperCase().startsWith("HERDR_");

// A VS Code started from a herdr action inherits HERDR_ENV, which makes herdr refuse to launch ("nested herdr").
export function herdrVarsToRemove(env: Readonly<Record<string, string | undefined>>): Record<string, null> {
  return Object.fromEntries(Object.keys(env).filter(isHerdrVar).map((key) => [key, null]));
}

export function withoutHerdrVars(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isHerdrVar(key)));
}
