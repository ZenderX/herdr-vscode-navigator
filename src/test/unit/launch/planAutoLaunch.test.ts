import assert from "node:assert/strict";
import { PENDING_TAKEOVER_MAX_MS, planAutoLaunch, planTakeover, type PlanInput, type TakeoverInput } from "../../../launch/planAutoLaunch";
import { LEASE_STALE_MS } from "../../../launch/navigatorLease";
import { reduce, type SessionRecord } from "../../../launch/sessionState";

const record: SessionRecord = { version: 1, herdrWasRunning: true, lastSpaceLabel: "api", lastFolder: "C:\\work\\api\\", updatedAt: 1 };
const base: PlanInput = {
  platform: "win32",
  enabled: true,
  isNavigatorWindow: true,
  record,
  now: 2,
  herdrHostingNow: false,
  herdrPath: "/bin/herdr",
  terminals: [],
  terminalName: "herdr",
};

describe("planAutoLaunch", () => {
  it("restores herdr only in an enabled navigator window where it ran, when it is installed and not already hosted", () => {
    assert.deepEqual(planAutoLaunch({ ...base, enabled: false }), { action: "none", reason: "disabled" });
    assert.deepEqual(planAutoLaunch({ ...base, isNavigatorWindow: false }), { action: "none", reason: "not-navigator" });
    assert.deepEqual(planAutoLaunch({ ...base, record: { ...record, herdrWasRunning: false } }), { action: "none", reason: "not-restored" });
    assert.deepEqual(planAutoLaunch({ ...base, herdrHostingNow: true }), { action: "none", reason: "already-hosting" });
    assert.deepEqual(planAutoLaunch({ ...base, herdrPath: undefined }), { action: "none", reason: "herdr-missing" });
  });

  it("creates herdr in the remembered folder, in each platform's path form, to re-focus the remembered space", () => {
    for (const [platform, lastFolder, cwd] of [
      ["win32", "C:\\work\\api\\", "C:\\work\\api"],
      ["linux", "/work/api/", "/work/api"],
      ["darwin", "/work/api/", "/work/api"],
    ] as const) {
      const plan = planAutoLaunch({ ...base, platform, record: { ...record, lastFolder } });
      assert.deepEqual(plan, { action: "create", name: "herdr", command: "herdr", cwd, focusLabel: "api" }, platform);
    }
  });

  it("reuses an un-interacted herdr terminal instead of opening a second one", () => {
    const terminals = [
      { name: "bash", isInteractedWith: false },
      { name: "herdr", isInteractedWith: true },
      { name: "herdr", isInteractedWith: false },
    ];
    assert.deepEqual(planAutoLaunch({ ...base, terminals }), { action: "reuse", terminalIndex: 2, command: "herdr", focusLabel: "api", cwd: "C:\\work\\api" });
    assert.equal(planAutoLaunch({ ...base, terminals: terminals.slice(0, 2) }).action, "create");
  });

  it("only attaches when an explicit launch finds a server running: keeps the cwd and a pending takeover, drops the remembered space", () => {
    const attach = planAutoLaunch({ ...base, explicit: true, serverRunning: true });
    assert.deepEqual(attach, { action: "create", name: "herdr", command: "herdr", cwd: "C:\\work\\api", focusLabel: undefined });
    assert.deepEqual(planAutoLaunch({ ...base, serverRunning: true }), planAutoLaunch(base));
    const pending = reduce(record, { type: "takeoverPending", folder: "C:\\work\\web\\" }, 2);
    const takeover = planAutoLaunch({ ...base, record: pending, explicit: true, serverRunning: true });
    assert.equal(takeover.action === "create" ? takeover.focusFolder : undefined, "C:\\work\\web\\");
  });

  it("launches in a fresh pending takeover folder once, then falls back to the remembered space", () => {
    const pending = reduce(record, { type: "takeoverPending", folder: "C:\\work\\web\\" }, 2);
    const first = planAutoLaunch({ ...base, record: pending, now: 2 + PENDING_TAKEOVER_MAX_MS });
    assert.equal(first.action === "create" ? first.focusFolder : undefined, "C:\\work\\web\\");
    assert.equal(first.action === "create" ? first.focusLabel : "x", undefined);
    assert.equal(first.action === "create" ? first.cwd : undefined, "C:\\work\\web");

    const consumed = reduce(pending, { type: "takeoverConsumed" }, 3);
    assert.deepEqual(planAutoLaunch({ ...base, record: consumed }), planAutoLaunch(base));
    const stale = planAutoLaunch({ ...base, record: pending, now: 3 + PENDING_TAKEOVER_MAX_MS });
    assert.deepEqual(stale, planAutoLaunch({ ...base, record: reduce(pending, { type: "takeoverConsumed" }, 2) }));
  });
});

describe("planTakeover", () => {
  it("converts a plain window after a navigator session unless a live lease of this launch vouches for a running navigator", () => {
    const old: SessionRecord = { version: 1, herdrWasRunning: true, launchId: "old", updatedAt: 1 };
    const now = 1_000_000;
    const input: TakeoverInput = { enabled: true, windowKind: "single-folder", folder: "/work/web", record: old, lease: undefined, launchId: "current", now };
    const lease = (launchId: string, writtenAt: number) => ({ launchId, writtenAt, folder: "/work/api" });

    assert.deepEqual(planTakeover(input), { action: "convert-explicit", folder: "/work/web" });
    assert.equal(planTakeover({ ...input, lease: lease("old", now) }).action, "convert-explicit");
    assert.equal(planTakeover({ ...input, lease: lease("current", now - LEASE_STALE_MS - 1) }).action, "convert-explicit");
    assert.deepEqual(planTakeover({ ...input, lease: lease("current", now - 1) }), { action: "none", reason: "navigator-alive" });

    assert.deepEqual(planTakeover({ ...input, record: { ...old, herdrWasRunning: false } }), { action: "none", reason: "not-navigator" });
    assert.deepEqual(planTakeover({ ...input, windowKind: "navigator-saved" }), { action: "none", reason: "is-navigator" });
    assert.deepEqual(planTakeover({ ...input, windowKind: "navigator-untitled", folder: undefined }), { action: "legacy-untitled" });
    assert.deepEqual(planTakeover({ ...input, enabled: false }), { action: "none", reason: "disabled" });
  });
});
