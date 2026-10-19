import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLeaseLive, LEASE_STALE_MS, readLease, writeLease } from "../../../launch/navigatorLease";

describe("navigatorLease", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lease-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through a file, creating missing directories", () => {
    const file = path.join(dir, "nested", "lease.json");
    const lease = { launchId: "s1", writtenAt: 5, folder: "/work/api" };
    writeLease(file, lease);
    assert.deepEqual(readLease(file), lease);
  });

  it("reads a missing file as no lease", () => {
    assert.equal(readLease(path.join(dir, "absent.json")), undefined);
  });

  it("rejects malformed content without throwing", () => {
    const file = path.join(dir, "lease.json");
    for (const content of ["not json", "null", '{"launchId":1,"writtenAt":2,"folder":"f"}', '{"launchId":"s"}']) {
      writeFileSync(file, content);
      assert.equal(readLease(file), undefined, content);
    }
  });

  it("reads a lease written with the old sessionId as one no launch matches", () => {
    const file = path.join(dir, "lease.json");
    writeFileSync(file, '{"sessionId":"123","writtenAt":100,"folder":"/f"}');
    const lease = readLease(file);
    assert.notEqual(lease, undefined);
    assert.equal(isLeaseLive(lease, "123", 100), false);
  });

  it("is live only for the current launch and within the staleness window", () => {
    const lease = { launchId: "s1", writtenAt: 100, folder: "/f" };
    assert.equal(isLeaseLive(lease, "s1", 100 + LEASE_STALE_MS), true);
    assert.equal(isLeaseLive(lease, "s1", 100 + LEASE_STALE_MS + 1), false);
    assert.equal(isLeaseLive(lease, "s2", 100), false);
    assert.equal(isLeaseLive(undefined, "s1", 100), false);
  });
});
