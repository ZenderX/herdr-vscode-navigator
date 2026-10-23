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

  it("round-trips through a file, and is live only for the current launch within the staleness window", () => {
    const file = path.join(dir, "nested", "lease.json");
    writeLease(file, { launchId: "s1", writtenAt: 100, folder: "/work/api" });
    const lease = readLease(file);
    assert.deepEqual(lease, { launchId: "s1", writtenAt: 100, folder: "/work/api" });
    assert.equal(isLeaseLive(lease, "s1", 100 + LEASE_STALE_MS), true);
    assert.equal(isLeaseLive(lease, "s1", 100 + LEASE_STALE_MS + 1), false);
    assert.equal(isLeaseLive(lease, "s2", 100), false);
    writeFileSync(file, "not json");
    assert.equal(readLease(file), undefined);
    assert.equal(isLeaseLive(undefined, "s1", 100), false);
  });
});
