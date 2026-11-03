import assert from "node:assert/strict";
import { parseOpenRequest } from "../../../uri/openRequest";

describe("parseOpenRequest", () => {
  it("accepts /open with a space and an optional session", () => {
    assert.deepEqual(parseOpenRequest({ path: "/open", query: "space=w_1:2" }), { ok: true, spaceId: "w_1:2" });
    assert.deepEqual(parseOpenRequest({ path: "/open/", query: "space=abc&session=my-sess.1" }), { ok: true, spaceId: "abc", session: "my-sess.1" });
    for (const path of ["/", "/opened", "/open/x", "/OPEN", ""]) assert.equal(parseOpenRequest({ path, query: "space=abc" }).ok, false, path);
  });

  it("rejects values outside the allowlist, unknown or duplicate keys, without echoing the input", () => {
    const bad = ["a&b", "a;b", "a b", 'a"b', "a'b", "a..b/c", "a%41", "a/b", "a+b", "a\nb", "$(x)", "a`b"];
    for (const space of bad) {
      const result = parseOpenRequest({ path: "/open", query: `space=${space}` });
      assert.equal(result.ok, false, space);
      if (!result.ok) assert.ok(!result.reason.includes(space), `reason echoed ${space}`);
    }
    assert.deepEqual(parseOpenRequest({ path: "/open", query: "space=w1&x=SECRETVALUE" }), { ok: false, reason: "unknown parameter" });
    assert.equal(parseOpenRequest({ path: "/open", query: "space=a&space=b" }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: "space=a&session=a:b" }).ok, false);
    assert.equal(parseOpenRequest({ path: "/open", query: "session=s" }).ok, false);
  });
});
