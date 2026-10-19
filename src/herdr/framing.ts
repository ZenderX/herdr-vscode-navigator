import { StringDecoder } from "node:string_decoder";

const MAX_LINE_BYTES = 4 * 1024 * 1024;

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
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    // Only the newly appended text is searched, so a long line costs linear time overall.
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
      const line = (this.buffer + text.slice(start, nl)).replace(/\r$/, "");
      this.buffer = "";
      start = nl + 1;
      if (line.length > MAX_LINE_BYTES) throw new Error(`herdr line exceeds ${MAX_LINE_BYTES} bytes`);
      if (line.length > 0) lines.push(line);
    }
    if (this.buffer.length + text.length - start > MAX_LINE_BYTES) {
      throw new Error(`herdr line exceeds ${MAX_LINE_BYTES} bytes`);
    }
    this.buffer += text.slice(start);
    return lines;
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
