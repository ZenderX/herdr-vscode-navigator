export type ServerProbe = { state: "running" } | { state: "stopped" } | { state: "unknown"; detail: string };

/** Only a missing socket (or a refused connect off Windows) shows that no server is there; anything else is doubt. */
export function classifyConnectError(code: string | undefined, platform: NodeJS.Platform): ServerProbe {
  if (code === "ENOENT" || (code === "ECONNREFUSED" && platform !== "win32")) return { state: "stopped" };
  return { state: "unknown", detail: code ?? "error" };
}

export const TIMEOUT_PROBE: ServerProbe = { state: "unknown", detail: "timeout" };
