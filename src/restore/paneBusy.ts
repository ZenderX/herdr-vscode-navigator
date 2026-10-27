import { nodeProbeDeps } from "../cwd/nodeDeps";
import { CHILDREN_SCRIPT } from "../cwd/shellCwd";
import type { Logger, PaneProcessInfo } from "../herdr/types";
import { readMsysEdges, withTimeout } from "../hosting";
import type { MsysEdge } from "../hosting";
import { createToolResolver } from "../toolPaths";

const BUSY_CHECK_TIMEOUT_MS = 5000;

/**
 * Windows rule: the pane's MSYS shells are the rows whose Windows pid is `shell_pid` or one of its direct Win32 children
 * (Git Bash's native launcher spawns the real MSYS bash); the pane is busy iff one of them has an MSYS child.
 */
export function msysShellBusy(edges: readonly MsysEdge[], shellPid: number, win32Children: readonly number[]): boolean {
  const shells = new Set([shellPid, ...win32Children]);
  return edges.some(({ parent }) => shells.has(parent));
}

/** Unix rule (inferred by the plugin, unmeasured): a second foreground process or a foreign foreground group means busy. */
export function foregroundBusy({ shell_pid, foreground_process_group_id, foreground_processes }: PaneProcessInfo): boolean {
  if (foreground_processes.length > 1) return true;
  return typeof foreground_process_group_id === "number" && foreground_process_group_id !== shell_pid;
}

export interface PaneBusyDeps {
  platform: NodeJS.Platform;
  readMsysEdges(): Promise<MsysEdge[]>;
  win32Children(pid: number): Promise<number[]>;
  log?: Logger;
}

/**
 * Returns a busy check for one look at the restored panes; the MSYS table is read once per check function.
 * Fails toward idle: no ps.exe, a failing child lookup, or a check over the timeout all report `false`.
 */
export function createPaneBusyCheck(deps: PaneBusyDeps): (info: PaneProcessInfo) => Promise<boolean> {
  let edges: Promise<MsysEdge[]> | undefined;
  return async (info) => {
    // herdr's process info is byte-identical idle vs busy on Windows, so only the MSYS process graph can tell.
    if (deps.platform !== "win32") return foregroundBusy(info);
    const { pane_id, shell_pid } = info;
    if (!Number.isInteger(shell_pid) || shell_pid <= 0) return false;
    edges ??= deps.readMsysEdges();
    try {
      const read = await withTimeout(Promise.all([edges, deps.win32Children(shell_pid)]), BUSY_CHECK_TIMEOUT_MS);
      if (!read) {
        deps.log?.("warn", `cwd-return: busy check for ${pane_id} timed out, treating it as idle`);
        return false;
      }
      return msysShellBusy(read[0], shell_pid, read[1]);
    } catch (error: unknown) {
      deps.log?.("warn", `cwd-return: busy check for ${pane_id} failed, treating it as idle: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
}

export function nodePaneBusyDeps(log?: Logger): PaneBusyDeps {
  const probe = nodeProbeDeps(log);
  const resolveTool = createToolResolver(probe);
  return {
    ...(log ? { log } : {}),
    platform: probe.platform,
    readMsysEdges,
    win32Children: async (pid) => {
      const { stdout } = await probe.execFile(
        resolveTool("powershell"),
        ["-NoProfile", "-NonInteractive", "-Command", CHILDREN_SCRIPT, String(pid)],
        BUSY_CHECK_TIMEOUT_MS,
      );
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number);
    },
  };
}
