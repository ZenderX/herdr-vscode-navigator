import { analyzeHosting, readProcessTable, withTimeout } from "../hosting";
import type { HostState } from "../hosting";
import type { Logger } from "../herdr";
import { errorText } from "../log";

/** Scans per request before coverage is given up on and `unknown` is published. */
const MAX_SCANS = 3;

/** One finished scan, immutable: what it saw is captured when it starts. */
export interface HostingResult<T> {
  seq: number;
  state: HostState;
  clientPids: readonly number[];
  terminalsScanned: readonly T[];
  startedAt: number;
}

export interface HostingMonitorDeps<T> {
  terminals: () => readonly T[];
  /** Scans exactly the given terminals. */
  scan: (terminals: readonly T[]) => Promise<{ state: HostState; clientPids: readonly number[] }>;
  now: () => number;
}

/** The only publisher of hosting results; a published `yes`/`no` always covers every terminal open when it finished, and exhausted retries publish a non-covering `unknown`. */
export class HostingMonitor<T> {
  private readonly subscribers: Array<(result: HostingResult<T>) => void> = [];
  private last: { result: HostingResult<T>; at: number } | undefined;
  private inflight: Promise<HostingResult<T>> | undefined;
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: HostingMonitorDeps<T>) {}

  subscribe(fn: (result: HostingResult<T>) => void): void {
    this.subscribers.push(fn);
  }

  /** Scans already in flight still finish, but nothing reaches subscribers afterwards. */
  dispose(): void {
    this.disposed = true;
    this.subscribers.length = 0;
  }

  /** Cached while fresh (5 s unless hosting, then 30 s); `force` skips the cache but still joins a request in progress. */
  request(force = false): Promise<HostingResult<T>> {
    if (this.inflight) return this.inflight;
    const { last } = this;
    if (!force && last && this.covers(last.result) && this.deps.now() - last.at < (last.result.state === "yes" ? 30_000 : 5_000)) {
      return Promise.resolve(last.result);
    }
    this.inflight = this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private covers(result: HostingResult<T>): boolean {
    return this.deps.terminals().every((terminal) => result.terminalsScanned.includes(terminal));
  }

  private async run(): Promise<HostingResult<T>> {
    let result = await this.scanOnce();
    for (let attempt = 1; attempt < MAX_SCANS && !this.covers(result); attempt++) result = await this.scanOnce();
    if (this.covers(result)) return this.publish(result);
    // Never publish a non-covering yes/no: it cannot speak for a terminal it did not see.
    return this.publish({ ...result, state: "unknown", clientPids: [] });
  }

  private async scanOnce(): Promise<HostingResult<T>> {
    const terminalsScanned = [...this.deps.terminals()];
    const startedAt = this.deps.now();
    const { state, clientPids } = await this.deps.scan(terminalsScanned);
    return { seq: ++this.seq, state, clientPids, terminalsScanned, startedAt };
  }

  private publish(result: HostingResult<T>): HostingResult<T> {
    this.last = { result, at: this.deps.now() };
    if (!this.disposed) for (const fn of this.subscribers) fn(result);
    return result;
  }
}

/** A terminal as far as hosting detection needs it. */
export interface ScannableTerminal {
  processId: PromiseLike<number | undefined>;
}

/** Looks for a herdr client in the process tree of the given terminals; any failure is `unknown`. */
export async function detectHosting(
  terminals: readonly ScannableTerminal[],
  platform: NodeJS.Platform,
  log: Logger,
): Promise<{ state: HostState; clientPids: readonly number[] }> {
  try {
    // A terminal whose process never launched must not stall detection; it is skipped after 2 s.
    const shellPids = (
      await Promise.all(terminals.map((t) => withTimeout(t.processId, 2_000)))
    ).filter((pid): pid is number => pid !== undefined);
    if (shellPids.length === 0) return { state: "no", clientPids: [] };
    const { table, msysEdges } = await readProcessTable(platform);
    return analyzeHosting(table, shellPids, msysEdges);
  } catch (err: unknown) {
    log("warn", `hosting detection failed: ${errorText(err)}`);
    return { state: "unknown", clientPids: [] };
  }
}
