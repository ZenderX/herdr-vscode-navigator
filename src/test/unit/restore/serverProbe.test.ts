import assert from "node:assert/strict";
import { TIMEOUT_PROBE, classifyConnectError } from "../../../restore/serverProbe";

describe("classifyConnectError", () => {
  it("treats a missing socket as stopped", () => {
    assert.deepEqual(classifyConnectError("ENOENT", "win32"), { state: "stopped" });
    assert.deepEqual(classifyConnectError("ENOENT", "linux"), { state: "stopped" });
  });

  it("treats a refused connect as stopped off Windows only", () => {
    assert.deepEqual(classifyConnectError("ECONNREFUSED", "linux"), { state: "stopped" });
    assert.deepEqual(classifyConnectError("ECONNREFUSED", "win32"), { state: "unknown", detail: "ECONNREFUSED" });
  });

  it("treats permission, busy and broken-pipe errors as unknown", () => {
    for (const code of ["EACCES", "EBUSY", "EPIPE"]) {
      assert.deepEqual(classifyConnectError(code, "linux"), { state: "unknown", detail: code });
    }
  });

  it("treats an error without a code, and the timeout, as unknown", () => {
    assert.deepEqual(classifyConnectError(undefined, "linux"), { state: "unknown", detail: "error" });
    assert.deepEqual(TIMEOUT_PROBE, { state: "unknown", detail: "timeout" });
  });
});
