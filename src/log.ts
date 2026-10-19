import type { LogOutputChannel } from "vscode";
import type { Logger, LogLevel } from "./herdr/types";

/** Message prefixes whose latest line the diagnostics command replays. */
export const DIAGNOSTIC_TOPICS = ["pane", "target", "plan", "mutation"] as const;

export interface DiagnosticLog {
  log: Logger;
  /** Latest message per topic, keyed by the `topic:` prefix of the logged message. */
  last(topic: (typeof DIAGNOSTIC_TOPICS)[number]): string | undefined;
}

/** Remembers the newest line of each diagnostic topic, whatever level VS Code shows. */
export function createLog(write: (level: LogLevel, msg: string) => void): DiagnosticLog {
  const latest = new Map<string, string>();
  const log: Logger = (level, msg) => {
    const topic = DIAGNOSTIC_TOPICS.find((candidate) => msg.startsWith(`${candidate}:`));
    if (topic) latest.set(topic, msg);
    write(level, msg);
  };
  return { log, last: (topic) => latest.get(topic) };
}

/** The channel stamps time and level itself and filters by VS Code's log-level setting. */
export function channelWriter(channel: LogOutputChannel): (level: LogLevel, msg: string) => void {
  return (level, msg) => channel[level](msg);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
