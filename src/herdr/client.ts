import * as net from "node:net";
import { encodeRequest, LineSplitter, nextRequestId, parseObject } from "./framing";
import type {
  BackoffOptions,
  HerdrClientOptions,
  HerdrEvent,
  Logger,
  PaneProcessInfo,
  PingResult,
  RequestOptions,
  SessionSnapshot,
  Subscription,
  SubscriptionHandlers,
} from "./types";

// Read-only methods only; keeps any mutating herdr call impossible by construction.
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "ping",
  "session.snapshot",
  "pane.get",
  "pane.list",
  "pane.process_info",
  "events.subscribe",
]);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BACKOFF: BackoffOptions = { minMs: 500, maxMs: 10_000 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const { code, message } = error;
  return `${String(code ?? "error")}: ${String(message ?? "")}`;
}

/** Unwraps a bare `{event,data}` line or one nested under `result`. */
function toEvent(line: Record<string, unknown>): HerdrEvent | null {
  const candidate = isRecord(line.result) ? line.result : line;
  const { event, data } = candidate;
  if (typeof event !== "string") return null;
  return { event, data: isRecord(data) ? data : {} };
}

export class HerdrClient {
  private readonly pipeName: string;
  private readonly log: Logger;
  private readonly backoff: BackoffOptions;

  constructor({ pipeName, log, backoff }: HerdrClientOptions) {
    this.pipeName = pipeName;
    this.log = log ?? (() => undefined);
    this.backoff = backoff ?? DEFAULT_BACKOFF;
  }

  request(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`herdr method not allowed: ${method}`));
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const id = nextRequestId();

    return new Promise<unknown>((resolve, reject) => {
      const splitter = new LineSplitter();
      const socket = net.createConnection(this.pipeName);
      let settled = false;
      const finish = (error: Error | null, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out after ${timeoutMs}ms`)), timeoutMs);

      socket.on("connect", () => socket.write(encodeRequest(id, method, params)));
      socket.on("error", (err) => finish(err));
      socket.on("close", () => finish(new Error(`herdr ${method}: connection closed before a response`)));
      socket.on("data", (chunk) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk);
        } catch (err: unknown) {
          finish(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        for (const line of lines) {
          const message = parseObject(line);
          if (!message) continue;
          if (message.id !== id && message.id !== "") continue;
          if ("error" in message) {
            finish(new Error(`herdr ${method} failed: ${describeError(message.error)}`));
            return;
          }
          finish(null, message.result);
          return;
        }
      });
    });
  }

  async ping(options?: RequestOptions): Promise<PingResult> {
    return (await this.request("ping", {}, options)) as PingResult;
  }

  async snapshot(options?: RequestOptions): Promise<SessionSnapshot> {
    const result = await this.request("session.snapshot", {}, options);
    if (!isRecord(result) || !isRecord(result.snapshot)) {
      throw new Error("herdr session.snapshot returned no snapshot");
    }
    return result.snapshot as SessionSnapshot;
  }

  async processInfo(paneId: string, options?: RequestOptions): Promise<PaneProcessInfo> {
    const result = await this.request("pane.process_info", { pane_id: paneId }, options);
    if (!isRecord(result) || !isRecord(result.process_info) || typeof result.process_info.shell_pid !== "number") {
      throw new Error("herdr pane.process_info returned no shell_pid");
    }
    return result.process_info as PaneProcessInfo;
  }

  /** Long-lived subscription that reconnects with jittered exponential backoff until disposed. */
  subscribe(types: readonly string[], handlers: SubscriptionHandlers): Subscription {
    let disposed = false;
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let attempt = 0;

    const scheduleReconnect = (): void => {
      const base = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** attempt);
      attempt += 1;
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this.log("debug", `herdr subscription reconnecting in ${delay}ms`);
      timer = setTimeout(connect, delay);
    };

    const connect = (): void => {
      if (disposed) return;
      const id = nextRequestId();
      const splitter = new LineSplitter();
      const sock = net.createConnection(this.pipeName);
      socket = sock;
      let ended = false;

      const end = (reason: string): void => {
        if (ended) return;
        ended = true;
        sock.destroy();
        if (disposed) return;
        this.log("warn", `herdr subscription lost: ${reason}`);
        handlers.onDisconnected?.(reason);
        scheduleReconnect();
      };

      const handleLine = (line: string): void => {
        const message = parseObject(line);
        if (!message) return;
        if ("error" in message) {
          end(describeError(message.error));
          return;
        }
        if (isRecord(message.result) && message.result.type === "subscription_started") {
          attempt = 0;
          handlers.onStarted?.();
          return;
        }
        const event = toEvent(message);
        if (event) handlers.onEvent(event);
        else this.log("debug", `herdr ignored line: ${line.slice(0, 200)}`);
      };

      sock.on("connect", () => {
        sock.write(encodeRequest(id, "events.subscribe", { subscriptions: types.map((type) => ({ type })) }));
      });
      sock.on("data", (chunk) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk);
        } catch (err: unknown) {
          end(err instanceof Error ? err.message : String(err));
          return;
        }
        for (const line of lines) {
          if (ended || disposed) return;
          handleLine(line);
        }
      });
      sock.on("error", (err) => end(err.message));
      sock.on("close", () => end("connection closed"));
    };

    connect();

    return {
      dispose: (): void => {
        disposed = true;
        clearTimeout(timer);
        socket?.destroy();
      },
    };
  }
}
