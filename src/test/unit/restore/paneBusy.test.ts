import assert from "node:assert/strict";
import type { PaneProcessInfo } from "../../../herdr/types";
import { parseMsysTable } from "../../../hosting";
import type { MsysEdge } from "../../../hosting";
import { createPaneBusyCheck } from "../../../restore/paneBusy";

// Git Bash panes: herdr's shell_pid is the native launcher (5000, 6000) whose Win32 child is the MSYS bash;
// pane 7100's shell_pid is itself an MSYS bash row.
const table = parseMsysTable(
  [
    "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
    "      700       1     700       5100 cons0       197609 09:00:01 /usr/bin/bash",
    "      701     700     701       5200 cons0       197609 09:00:05 /usr/bin/vim",
    "      800       1     800       6100 cons1       197609 09:00:02 /usr/bin/bash",
    "      900       1     900       7100 cons2       197609 09:00:03 /usr/bin/bash",
    "      901     900     901       7200 cons2       197609 09:00:06 /usr/bin/sleep",
  ].join("\n"),
);
const children: Record<number, number[]> = { 5000: [5100], 6000: [6100], 7100: [7200] };

const info = (shell_pid: number, extra: Partial<PaneProcessInfo> = {}): PaneProcessInfo => ({
  pane_id: `w1:p${shell_pid}`,
  shell_pid,
  foreground_processes: [],
  ...extra,
});

const windowsCheck = (edges: MsysEdge[]) =>
  createPaneBusyCheck({ platform: "win32", readMsysEdges: async () => edges, win32Children: async (pid) => children[pid] ?? [] });

describe("createPaneBusyCheck", () => {
  // A cd typed into a pane running a program would land in that program's input instead of the shell.
  it("reports busy only when the pane's MSYS shell has a child, and idle when ps is unavailable", async () => {
    const busy = windowsCheck(table);
    assert.equal(await busy(info(5000)), true, "MSYS bash found through the launcher's Win32 child, with a vim child");
    assert.equal(await busy(info(6000)), false, "MSYS bash found through the launcher's Win32 child, no child row");
    assert.equal(await busy(info(7100)), true, "shell_pid is the MSYS bash row itself");
    assert.equal(await windowsCheck([])(info(5000)), false, "no ps.exe means an empty table, so idle");

    const unix = createPaneBusyCheck({ platform: "linux", readMsysEdges: async () => table, win32Children: async () => [] });
    const fg = (pid: number) => ({ pid, name: "x", argv0: "x", argv: [], cmdline: "x", cwd: "/" });
    assert.equal(await unix(info(42, { foreground_process_group_id: 42, foreground_processes: [fg(42)] })), false);
    assert.equal(await unix(info(42, { foreground_process_group_id: 43, foreground_processes: [fg(43)] })), true);
    assert.equal(await unix(info(42, { foreground_processes: [fg(42), fg(44)] })), true);
  });
});
