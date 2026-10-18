import assert from "node:assert/strict";
import { planAutoLaunch, type PlanInput } from "../../../launch/planAutoLaunch";
import type { SessionRecord } from "../../../launch/sessionState";

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
  });
}
