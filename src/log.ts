import type { Logger } from "./herdr";

/** Message prefixes whose latest line the diagnostics command replays. */
export const DIAGNOSTIC_TOPICS = ["pane", "target", "plan", "mutation"] as const;

export interface DiagnosticLog {
  log: Logger;
  /** Latest message per topic, keyed by the `topic:` prefix of the logged message. */
  last(topic: (typeof DIAGNOSTIC_TOPICS)[number]): string | undefined;
}

/** Timestamps every line and remembers the newest line of each diagnostic topic. */
export function createLog(write: (line: string) => void, now: () => Date = () => new Date()): DiagnosticLog {
  const latest = new Map<string, string>();
  const log: Logger = (level, msg) => {
    const topic = DIAGNOSTIC_TOPICS.find((candidate) => msg.startsWith(`${candidate}:`));
    if (topic) latest.set(topic, msg);
    write(`${now().toISOString()} [${level}] ${msg}`);
  };
  return { log, last: (topic) => latest.get(topic) };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
