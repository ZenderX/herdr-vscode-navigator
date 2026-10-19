import assert from "node:assert/strict";
import { PENDING_TAKEOVER_MAX_MS, planAutoLaunch, planTakeover, type PlanInput, type TakeoverInput } from "../../../launch/planAutoLaunch";
import { LEASE_STALE_MS } from "../../../launch/navigatorLease";
import { reduce, type SessionRecord } from "../../../launch/sessionState";

const platforms: NodeJS.Platform[] = ["win32", "linux", "darwin"];

const folderFor = (platform: NodeJS.Platform): string => (platform === "win32" ? "C:\\work\\api\\" : "/work/api/");
const expectedCwd = (platform: NodeJS.Platform): string => (platform === "win32" ? "C:\\work\\api" : "/work/api");

for (const platform of platforms) {
  describe(`planAutoLaunch (${platform})`, () => {
    const record: SessionRecord = {
      version: 1,
      herdrWasRunning: true,
      lastSpaceLabel: "api",
      lastFolder: folderFor(platform),
      updatedAt: 1,
    };
    const base: PlanInput = {
      platform,
      enabled: true,
      isNavigatorWindow: true,
      record,
      now: 2,
      herdrHostingNow: false,
      herdrPath: "/bin/herdr",
      terminals: [],
      terminalName: "herdr",
    };

    it("disabled", () => {
      assert.deepEqual(planAutoLaunch({ ...base, enabled: false }), { action: "none", reason: "disabled" });
    });
    it("non-navigator", () => {
      assert.deepEqual(planAutoLaunch({ ...base, isNavigatorWindow: false }), { action: "none", reason: "not-navigator" });
    });
    it("herdr was not running", () => {
      const plan = planAutoLaunch({ ...base, record: { ...record, herdrWasRunning: false } });
      assert.deepEqual(plan, { action: "none", reason: "not-restored" });
    });
    it("already hosting", () => {
      assert.deepEqual(planAutoLaunch({ ...base, herdrHostingNow: true }), { action: "none", reason: "already-hosting" });
    });
    it("herdr missing", () => {
      assert.deepEqual(planAutoLaunch({ ...base, herdrPath: undefined }), { action: "none", reason: "herdr-missing" });
    });
    it("reuses an un-interacted herdr terminal", () => {
      const terminals = [
        { name: "bash", isInteractedWith: false },
        { name: "herdr", isInteractedWith: true },
        { name: "herdr", isInteractedWith: false },
      ];
      assert.deepEqual(planAutoLaunch({ ...base, terminals }), {
        action: "reuse",
        terminalIndex: 2,
        command: "herdr",
        focusLabel: "api",
        cwd: expectedCwd(platform),
      });
    });
    it("creates when the only herdr terminal was interacted with", () => {
      const terminals = [{ name: "herdr", isInteractedWith: true }];
      assert.equal(planAutoLaunch({ ...base, terminals }).action, "create");
    });
    it("creates when there are no terminals, propagating cwd and focusLabel", () => {
      assert.deepEqual(planAutoLaunch(base), {
        action: "create",
        name: "herdr",
        command: "herdr",
        cwd: expectedCwd(platform),
        focusLabel: "api",
      });
    });
    it("omits cwd and focusLabel when the record has none", () => {
      const plan = planAutoLaunch({ ...base, record: { version: 1, herdrWasRunning: true, updatedAt: 1 } });
      assert.deepEqual(plan, { action: "create", name: "herdr", command: "herdr", cwd: undefined, focusLabel: undefined });
    });
    it("launches in the pending takeover folder once, then falls back to the remembered space", () => {
      const pendingFolder = folderFor(platform).replace("api", "web");
      const pending = reduce(record, { type: "takeoverPending", folder: pendingFolder }, 2);
      const first = planAutoLaunch({ ...base, record: pending });
      assert.equal(first.action, "create");
      assert.equal(first.action === "create" ? first.focusFolder : undefined, pendingFolder);
      assert.equal(first.action === "create" ? first.focusLabel : "x", undefined);
      assert.equal(first.action === "create" ? first.cwd : undefined, expectedCwd(platform).replace("api", "web"));

      const consumed = reduce(pending, { type: "takeoverConsumed" }, 3);
      assert.deepEqual(planAutoLaunch({ ...base, record: consumed }), planAutoLaunch(base));
    });
    it("ignores a pending takeover older than the bound and uses the remembered space", () => {
      const pending = reduce(record, { type: "takeoverPending", folder: folderFor(platform).replace("api", "web") }, 2);
      const fresh = planAutoLaunch({ ...base, record: pending, now: 2 + PENDING_TAKEOVER_MAX_MS });
      assert.equal(fresh.action === "create" ? fresh.focusFolder : undefined, folderFor(platform).replace("api", "web"));
      const stale = planAutoLaunch({ ...base, record: pending, now: 3 + PENDING_TAKEOVER_MAX_MS });
      assert.deepEqual(stale, planAutoLaunch({ ...base, record: reduce(pending, { type: "takeoverConsumed" }, 2) }));
    });
  });
}

describe("planTakeover", () => {
  const record: SessionRecord = { version: 1, herdrWasRunning: true, launchId: "old", updatedAt: 1 };
  const now = 1_000_000;
  const base: TakeoverInput = {
    enabled: true,
    windowKind: "single-folder",
    folder: "/work/web",
    record,
    lease: undefined,
    launchId: "current",
    now,
  };

  it("takes over when the previous session ran a navigator and no lease exists", () => {
    assert.deepEqual(planTakeover(base), { action: "convert-explicit", folder: "/work/web" });
  });
  it("takes over when the record predates launchId", () => {
    const { launchId: _omit, ...legacy } = record;
    assert.equal(planTakeover({ ...base, record: legacy }).action, "convert-explicit");
  });
  it("takes over when the lease belongs to a previous launch", () => {
    const lease = { launchId: "old", writtenAt: now, folder: "/work/api" };
    assert.equal(planTakeover({ ...base, lease }).action, "convert-explicit");
  });
  it("takes over when the lease of this launch is stale", () => {
    const lease = { launchId: "current", writtenAt: now - LEASE_STALE_MS - 1, folder: "/work/api" };
    assert.equal(planTakeover({ ...base, lease }).action, "convert-explicit");
  });
  it("yields to a live navigator holding a lease for this launch", () => {
    const lease = { launchId: "current", writtenAt: now - 1, folder: "/work/api" };
    assert.deepEqual(planTakeover({ ...base, lease }), { action: "none", reason: "navigator-alive" });
  });
  it("takes over when the record carries this launch id but no live lease vouches for the navigator", () => {
    const sameLaunch = { ...record, launchId: "current" };
    assert.deepEqual(planTakeover({ ...base, record: sameLaunch }), { action: "convert-explicit", folder: "/work/web" });
  });
  it("takes over 120 s after a closed navigator's last lease write", () => {
    const lease = { launchId: "current", writtenAt: now - 120_000, folder: "/work/api" };
    assert.equal(planTakeover({ ...base, record: { ...record, launchId: "current" }, lease }).action, "convert-explicit");
  });
  it("does nothing when the previous session had no navigator", () => {
    assert.deepEqual(planTakeover({ ...base, record: { ...record, herdrWasRunning: false } }), {
      action: "none",
      reason: "not-navigator",
    });
  });
  it("does nothing for other window shapes and a saved navigator", () => {
    assert.deepEqual(planTakeover({ ...base, windowKind: "other" }), { action: "none", reason: "not-navigator" });
    assert.deepEqual(planTakeover({ ...base, windowKind: "navigator-saved" }), { action: "none", reason: "is-navigator" });
  });
  it("flags an untitled navigator for migration", () => {
    assert.deepEqual(planTakeover({ ...base, windowKind: "navigator-untitled", folder: undefined }), { action: "legacy-untitled" });
  });
  it("does nothing when disabled", () => {
    assert.deepEqual(planTakeover({ ...base, enabled: false }), { action: "none", reason: "disabled" });
  });
});
