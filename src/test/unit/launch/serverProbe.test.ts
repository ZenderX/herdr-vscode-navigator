import assert from "node:assert/strict";
import { TIMEOUT_PROBE, classifyConnectError } from "../../../launch/serverProbe";

describe("classifyConnectError", () => {
  it("reports stopped only for a missing socket or, off Windows, a refused connect; anything else is unknown", () => {
    assert.deepEqual(classifyConnectError("ENOENT", "win32"), { state: "stopped" });
    assert.deepEqual(classifyConnectError("ENOENT", "linux"), { state: "stopped" });
    assert.deepEqual(classifyConnectError("ECONNREFUSED", "linux"), { state: "stopped" });
    assert.deepEqual(classifyConnectError("ECONNREFUSED", "win32"), { state: "unknown", detail: "ECONNREFUSED" });
    assert.deepEqual(classifyConnectError("EACCES", "linux"), { state: "unknown", detail: "EACCES" });
    assert.deepEqual(classifyConnectError(undefined, "linux"), { state: "unknown", detail: "error" });
    assert.deepEqual(TIMEOUT_PROBE, { state: "unknown", detail: "timeout" });
  });
});
