export type OpenRequestResult =
  | { ok: true; spaceId: string; session?: string }
  | { ok: false; reason: string };

const SPACE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// The query is untrusted. Callers pass VS Code's already-decoded `Uri.query`, so an encoded `&` or `=`
// in a value is indistinguishable from a separator; any `%` or `+` left is a second encoding and is rejected.
// Reasons name the offending part only and never echo the raw value.
export function parseOpenRequest(input: { path: string; query: string }): OpenRequestResult {
  if (input.path !== "/open" && input.path !== "/open/") {
    return { ok: false, reason: "unsupported path" };
  }
  if (/[%+]/.test(input.query)) return { ok: false, reason: "encoded query" };

  const spaces: string[] = [];
  const sessions: string[] = [];
  for (const part of input.query === "" ? [] : input.query.split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    if (key === "space") spaces.push(value);
    else if (key === "session") sessions.push(value);
    else return { ok: false, reason: "unknown parameter" };
  }

  if (spaces.length === 0) return { ok: false, reason: "missing space" };
  if (spaces.length > 1) return { ok: false, reason: "duplicate space" };
  if (sessions.length > 1) return { ok: false, reason: "duplicate session" };
  if (!SPACE_PATTERN.test(spaces[0])) return { ok: false, reason: "invalid space" };

  if (sessions.length === 0) return { ok: true, spaceId: spaces[0] };
  if (!SESSION_PATTERN.test(sessions[0])) return { ok: false, reason: "invalid session" };
  return { ok: true, spaceId: spaces[0], session: sessions[0] };
}

