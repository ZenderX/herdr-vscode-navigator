export const REFOCUS_PLUGIN_ID = "zenderx.herdr-navigator";
const LIST_TIMEOUT_MS = 3000;

export type PluginState = "present" | "absent" | "unknown";

/** Runs a binary with args; rejects on spawn error, timeout, or non-zero exit. */
export type RunTool = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ stdout: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginsOf(json: unknown): unknown[] | undefined {
  if (Array.isArray(json)) return json;
  if (!isRecord(json)) return undefined;
  if (Array.isArray(json.plugins)) return json.plugins;
  return pluginsOf(json.result);
}

/** Reads `herdr plugin list --json` output: a bare array, `{plugins}`, or `{result: {plugins}}` (the shape herdr 0.9 prints, with `plugin_id`). */
export function parsePluginList(stdout: string): PluginState {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  const plugins = pluginsOf(json);
  if (plugins === undefined) return "unknown";
  const found = plugins.some((plugin) => isRecord(plugin) && (plugin.plugin_id === REFOCUS_PLUGIN_ID || plugin.id === REFOCUS_PLUGIN_ID) && plugin.enabled !== false);
  return found ? "present" : "absent";
}

/** One cheap list call; any failure is "unknown" so the caller falls back to its own re-focus. */
export async function detectRefocusPlugin(run: RunTool, herdrPath: string): Promise<PluginState> {
  try {
    const { stdout } = await run(herdrPath, ["plugin", "list", "--json"], LIST_TIMEOUT_MS);
    return parsePluginList(stdout);
  } catch {
    return "unknown";
  }
}
