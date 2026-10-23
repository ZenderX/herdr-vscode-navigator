import * as assert from "node:assert/strict";
import { createLiveCwdProbe, resolveCwd } from "../../../cwd/liveCwd";
import type { ProbeDeps } from "../../../cwd/types";

const enabled = { enabled: true };
const pane = { cwd: "C:\\Users\\me\\", foreground_cwd: "C:\\Users\\me\\fg" };

describe("resolveCwd", () => {
  it("prefers a successful probe, then foreground_cwd, then cwd, recording why each earlier source failed", () => {
    assert.deepEqual(resolveCwd(pane, { ok: true, path: "C:\\live" }, enabled, "win32"), { path: "C:\\live", source: "probe", attempts: [] });

    const failed = resolveCwd(pane, { ok: false, reason: "not an MSYS process" }, enabled, "win32");
    assert.equal(failed.path, "C:\\Users\\me\\fg");
    assert.deepEqual(failed.attempts, [{ source: "probe", reason: "not an MSYS process" }]);

    const cwdOnly = resolveCwd({ cwd: "C:\\Users\\me\\" }, { ok: false, reason: "x" }, enabled, "win32");
    assert.equal(cwdOnly.path, "C:\\Users\\me");
    assert.deepEqual(cwdOnly.attempts.map(({ source }) => source), ["probe", "foreground_cwd"]);

    const disabled = resolveCwd(pane, { ok: true, path: "C:\\live" }, { enabled: false }, "win32");
    assert.deepEqual(disabled.attempts, [{ source: "probe", reason: "disabled" }]);
  });
});

describe("createLiveCwdProbe", () => {
  it("reports a pane.process_info failure as a reason instead of throwing", async () => {
    const deps: ProbeDeps = {
      platform: "linux",
      env: {},
      readlink: () => Promise.resolve("/x"),
      execFile: () => Promise.reject(new Error("unused")),
      exists: () => false,
      isDirectory: () => Promise.resolve(true),
    };
    const live = createLiveCwdProbe({ processInfo: () => Promise.reject(new Error("pipe gone")) }, deps);
    const result = await live.probe("w1:p1", { enabled: true, gitBashPath: "" });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /pipe gone/);
  });
});
