import assert from "node:assert/strict";
import { empty, readRecord, reduce } from "../../../launch/sessionState";

describe("sessionState", () => {
  it("hostingSeen marks herdr as running", () => {
    const next = reduce(empty(), { type: "hostingSeen" }, 5);
    assert.equal(next.herdrWasRunning, true);
    assert.equal(next.updatedAt, 5);
  });

  for (const reason of ["herdr-exited", "terminal-closed-by-user"] as const) {
    it(`hostingLost(${reason}) clears the flag`, () => {
      const running = reduce(empty(), { type: "hostingSeen" }, 1);
      assert.equal(reduce(running, { type: "hostingLost", reason }, 2).herdrWasRunning, false);
    });
  }

  for (const reason of ["shutdown", "unknown"] as const) {
    it(`hostingLost(${reason}) keeps the flag`, () => {
      const running = reduce(empty(), { type: "hostingSeen" }, 1);
      const next = reduce(running, { type: "hostingLost", reason }, 2);
      assert.equal(next.herdrWasRunning, true);
      assert.deepEqual(next, running);
    });
  }

  it("spaceFocused stores label and folder", () => {
    const next = reduce(empty(), { type: "spaceFocused", label: "api", folder: "/w/api" }, 3);
    assert.equal(next.lastSpaceLabel, "api");
    assert.equal(next.lastFolder, "/w/api");
  });

  it("missing, malformed and wrong-version records read as empty", () => {
    assert.deepEqual(readRecord(undefined), empty());
    assert.deepEqual(readRecord("x"), empty());
    assert.deepEqual(readRecord({ version: 2, herdrWasRunning: true, updatedAt: 1 }), empty());
    assert.deepEqual(readRecord({ version: 1, herdrWasRunning: "yes", updatedAt: 1 }), empty());
  });

  it("a valid record round-trips", () => {
    const rec = reduce(reduce(empty(), { type: "hostingSeen" }, 1), { type: "spaceFocused", label: "a", folder: "/f" }, 2);
    assert.deepEqual(readRecord(JSON.parse(JSON.stringify(rec))), rec);
  });
});
