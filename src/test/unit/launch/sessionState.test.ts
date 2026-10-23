import assert from "node:assert/strict";
import { empty, readRecord, reduce } from "../../../launch/sessionState";

describe("sessionState", () => {
  it("remembers herdr as running until it exits or the user closes its terminal, but not across a shutdown or an unknown loss", () => {
    const running = reduce(reduce(empty(), { type: "hostingSeen", launchId: "s1" }, 1), { type: "spaceFocused", label: "api", folder: "/w/api" }, 2);
    assert.deepEqual(readRecord(JSON.parse(JSON.stringify(running))), running);
    assert.equal(running.lastSpaceLabel, "api");
    for (const reason of ["herdr-exited", "terminal-closed-by-user"] as const) {
      assert.equal(reduce(running, { type: "hostingLost", reason }, 3).herdrWasRunning, false, reason);
    }
    for (const reason of ["shutdown", "unknown"] as const) {
      assert.deepEqual(reduce(running, { type: "hostingLost", reason }, 3), running, reason);
    }
    assert.deepEqual(readRecord({ version: 2, herdrWasRunning: true, updatedAt: 1 }), empty());
  });
});
