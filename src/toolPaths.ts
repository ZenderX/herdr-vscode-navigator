import * as path from "node:path";
import type { Logger } from "./herdr/types";

export type Tool = "ps" | "powershell" | "lsof";

export interface ToolPathDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  log?: Logger;
}

const BARE_NAME: Record<Tool, string> = { ps: "ps", powershell: "powershell.exe", lsof: "lsof" };

function candidates(tool: Tool, platform: NodeJS.Platform, env: ToolPathDeps["env"]): string[] {
  if (platform === "win32") {
    if (tool !== "powershell") return [];
    return [path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
  }
  if (tool === "ps") return platform === "darwin" ? ["/bin/ps"] : ["/bin/ps", "/usr/bin/ps"];
  if (tool === "lsof" && platform === "darwin") return ["/usr/sbin/lsof"];
  return [];
}

/**
 * Resolves a tool to its absolute system path so a same-named program earlier in PATH is not run;
 * falls back to the bare name when no candidate exists. Each tool is resolved once per resolver.
 */
export function createToolResolver({ platform, env, exists, log }: ToolPathDeps): (tool: Tool) => string {
  const resolved = new Map<Tool, string>();
  return (tool) => {
    const known = resolved.get(tool);
    if (known !== undefined) return known;
    const list = candidates(tool, platform, env);
    const found = list.find((candidate) => exists(candidate));
    if (found === undefined && list.length > 0) log?.("debug", `tool: ${list.join(" or ")} not found, using "${BARE_NAME[tool]}" from PATH`);
    const result = found ?? BARE_NAME[tool];
    resolved.set(tool, result);
    return result;
  };
}
