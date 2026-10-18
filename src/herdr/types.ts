export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string | null;
  foreground_cwd?: string | null;
  [key: string]: unknown;
}

export interface SessionSnapshot {
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  panes: PaneInfo[];
  tabs: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
  version?: string;
  protocol?: number;
  [key: string]: unknown;
}

export interface PingResult {
  type: string;
  version: string;
  protocol: number;
  [key: string]: unknown;
}

export interface ForegroundProcess {
  pid: number;
  name: string;
  argv0?: string;
  argv?: string[];
  cmdline?: string;
  cwd?: string | null;
  [key: string]: unknown;
}

// Live capture 2026-10-17, herdr 0.9.5 on Windows. Response is
// result: { type: "pane_process_info", process_info: { pane_id, shell_pid, foreground_process_group_id,
// foreground_processes: [{ pid, name, argv0, argv, cmdline, cwd }] } }.
export interface PaneProcessInfo {
  pane_id: string;
  shell_pid: number;
  foreground_process_group_id?: number | null;
  foreground_processes: ForegroundProcess[];
  [key: string]: unknown;
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string) => void;

export interface RequestOptions {
  timeoutMs?: number;
}

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
}

export interface HerdrClientOptions {
  /** Full pipe name, e.g. from resolvePipeName(). */
  pipeName: string;
  log?: Logger;
  backoff?: BackoffOptions;
}

export interface SubscriptionHandlers {
  onStarted?: () => void;
  onEvent: (event: HerdrEvent) => void;
  onDisconnected?: (reason: string) => void;
}

export interface Subscription {
  dispose(): void;
}
