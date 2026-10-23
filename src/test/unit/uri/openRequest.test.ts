import assert from "node:assert/strict";
import { buildOpenUri, parseOpenRequest } from "../../../uri/openRequest";

describe("parseOpenRequest", () => {
  it("accepts a space only", () => {
    assert.deepEqual(parseOpenRequest({ path: "/open", query: "space=w_1:2" }), {
      ok: true,
      spaceId: "w_1:2",
    });
  });

  it("accepts a space and session, and a trailing slash", () => {
    assert.deepEqual(parseOpenRequest({ path: "/open/", query: "space=abc&session=my-sess.1" }), {
      ok: true,
      spaceId: "abc",
      session: "my-sess.1",
    });
  });

  it("rejects other paths", () => {
    for (const path of ["/", "/opened", "/open/x", "/OPEN", ""]) {
      assert.equal(parseOpenRequest({ path, query: "space=abc" }).ok, false, path);
    }
  });

  it("rejects a missing space", () => {
    assert.deepEqual(parseOpenRequest({ path: "/open", query: "session=s" }), {
      ok: false,
      reason: "missing space",
    });
  });

  it("rejects duplicate space and duplicate session", () => {
    assert.equal(parseOpenRequest({ path: "/open", query: "space=a&space=b" }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: "space=a&session=s&session=t" }).ok, false);
  });

  it("rejects characters outside the allowlist without echoing them", () => {
    const bad = ["a&b", "a;b", "a b", 'a"b', "a'b", "a..b/c", "a%41", "a/b", "a+b", "a\nb", "$(x)", "a`b"];
    for (const space of bad) {
      const result = parseOpenRequest({ path: "/open", query: `space=${space}` });
      assert.equal(result.ok, false, space);
      if (!result.ok) assert.ok(!result.reason.includes(space), `reason echoed ${space}`);
    }
  });

  it("rejects a decoded encoded-separator that would split into extra parameters", () => {
    assert.deepEqual(parseOpenRequest({ path: "/open", query: "space=w1&b" }), {
      ok: false,
      reason: "unknown parameter",
    });
    assert.equal(parseOpenRequest({ path: "/open", query: "space=w1&session=evil" }).ok, true);
    assert.equal(parseOpenRequest({ path: "/open", query: "space=w1&space=w2" }).ok, false);
  });

  it("does not decode a second time", () => {
    assert.equal(parseOpenRequest({ path: "/open", query: "space=w%31" }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: "space=a+b" }).ok, false);
  });

  it("rejects an unknown key without echoing its value", () => {
    const result = parseOpenRequest({ path: "/open", query: "space=w1&x=SECRETVALUE" });
    assert.deepEqual(result, { ok: false, reason: "unknown parameter" });
  });

  it("rejects a session containing a colon or other disallowed characters", () => {
    for (const session of ["a:b", "a b", "a;b", "a/b"]) {
      const result = parseOpenRequest({ path: "/open", query: `space=a&session=${session}` });
      assert.equal(result.ok, false, session);
    }
  });

  it("rejects empty and over-length values", () => {
    assert.equal(parseOpenRequest({ path: "/open", query: "space=" }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: `space=${"a".repeat(129)}` }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: `space=${"a".repeat(128)}` }).ok, true);
    assert.equal(parseOpenRequest({ path: "/open", query: `space=a&session=${"s".repeat(65)}` }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: `space=a&session=${"s".repeat(64)}` }).ok, true);
  });
});

describe("buildOpenUri", () => {
  it("builds the canonical URI with the given scheme", () => {
    assert.equal(buildOpenUri("vscode", "w1"), "vscode://z3nder.herdr-navigator/open?space=w1");
    assert.equal(
      buildOpenUri("vscode-insiders", "w1", "s1"),
      "vscode-insiders://z3nder.herdr-navigator/open?space=w1&session=s1",
    );
  });

  it("round-trips through the parser", () => {
    const uri = new URL(buildOpenUri("vscode", "w_1:2", "main.1"));
    assert.deepEqual(parseOpenRequest({ path: uri.pathname, query: decodeURIComponent(uri.search.slice(1)) }), {
      ok: true,
      spaceId: "w_1:2",
      session: "main.1",
    });
  });
});
