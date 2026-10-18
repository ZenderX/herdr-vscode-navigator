import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req_${requestCounter}`;
}

export function encodeRequest(id: string, method: string, params: unknown): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

/** Splits a byte stream into NDJSON lines, tolerating partial chunks. */
export class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_LINE_BYTES || lines.some((l) => l.length > MAX_LINE_BYTES)) {
      throw new Error(`herdr line exceeds ${MAX_LINE_BYTES} bytes`);
    }
    return lines.map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  }
}

export function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
