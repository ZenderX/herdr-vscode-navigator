import * as assert from "node:assert/strict";
import { createLiveCwdProbe, resolveCwd } from "../../../cwd/liveCwd";
import type { ProbeDeps } from "../../../cwd/types";

const enabled = { enabled: true };
const pane = { cwd: "C:\\Users\\me\\", foreground_cwd: "C:\\Users\\me\\fg" };

describe("resolveCwd", () => {
  it("prefers a successful probe over foreground_cwd and cwd", () => {
    const result = resolveCwd(pane, { ok: true, path: "C:\\live" }, enabled, "win32");
    assert.deepEqual(result, { path: "C:\\live", source: "probe", attempts: [] });
  });

  it("falls back to foreground_cwd when the probe fails, recording why", () => {
    const result = resolveCwd(pane, { ok: false, reason: "not an MSYS process" }, enabled, "win32");
    assert.equal(result.source, "foreground_cwd");
    assert.equal(result.path, "C:\\Users\\me\\fg");
    assert.deepEqual(result.attempts, [{ source: "probe", reason: "not an MSYS process" }]);
  });

  it("falls back to cwd when foreground_cwd is absent", () => {
    const result = resolveCwd({ cwd: "C:\\Users\\me\\" }, { ok: false, reason: "x" }, enabled, "win32");
    assert.equal(result.source, "cwd");
    assert.equal(result.path, "C:\\Users\\me");
    assert.deepEqual(result.attempts.map(({ source }) => source), ["probe", "foreground_cwd"]);
  });

  it("ignores a successful probe when disabled", () => {
    const result = resolveCwd(pane, { ok: true, path: "C:\\live" }, { enabled: false }, "win32");
    assert.equal(result.source, "foreground_cwd");
    assert.deepEqual(result.attempts, [{ source: "probe", reason: "disabled" }]);
  });

  it("returns no target when nothing is usable", () => {
    const result = resolveCwd({ cwd: "relative" }, undefined, enabled, "win32");
    assert.equal(result.path, null);
    assert.equal(result.source, null);
    assert.equal(result.attempts.length, 3);
  });

  it("accepts absolute POSIX paths on non-Windows platforms", () => {
    const result = resolveCwd({ cwd: "/home/me/proj/" }, undefined, enabled, "linux");
    assert.deepEqual(result.path, "/home/me/proj");
  });
});

describe("createLiveCwdProbe", () => {
  const deps = (readlink: ProbeDeps["readlink"]): ProbeDeps => ({
    platform: "linux",
    env: {},
    readlink,
    execFile: () => Promise.reject(new Error("unused")),
    exists: () => false,
    isDirectory: () => Promise.resolve(true),
  });
  const settings = { enabled: true, gitBashPath: "" };

  it("shares one in-flight probe among concurrent callers of the same pane", async () => {
    let infoCalls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = {
      processInfo: async () => {
        infoCalls += 1;
        await gate;
        return { shell_pid: 11 };
      },
    };
    const live = createLiveCwdProbe(client, deps(() => Promise.resolve("/work")));
    const first = live.probe("w1:p1", settings);
    const second = live.probe("w1:p1", settings);
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      { ok: true, path: "/work" },
      { ok: true, path: "/work" },
    ]);
    assert.equal(infoCalls, 1);
    await live.probe("w1:p1", settings);
    assert.equal(infoCalls, 2, "no cache beyond the in-flight promise");
  });

  it("lets a second caller reuse a result finished within its window, so one cycle spawns one probe", async () => {
    let infoCalls = 0;
    let clock = 1_000;
    const client = {
      processInfo: () => {
        infoCalls += 1;
        return Promise.resolve({ shell_pid: 11 });
      },
    };
    const live = createLiveCwdProbe(client, { ...deps(() => Promise.resolve("/work")), now: () => clock });
    await live.probe("w1:p1", settings);
    clock += 1_000;
    assert.deepEqual(await live.probe("w1:p1", settings, 3_000), { ok: true, path: "/work" });
    assert.equal(infoCalls, 1, "reused within the window");
    clock += 3_000;
    await live.probe("w1:p1", settings, 3_000);
    assert.equal(infoCalls, 2, "probes again once the result is older than the window");
  });

  it("reports a pane.process_info failure as a reason instead of throwing", async () => {
    const live = createLiveCwdProbe({ processInfo: () => Promise.reject(new Error("pipe gone")) }, deps(() => Promise.resolve("/x")));
    const result = await live.probe("w1:p1", settings);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /pipe gone/);
  });

  it("reports a failing readlink as a reason", async () => {
    const live = createLiveCwdProbe({ processInfo: () => Promise.resolve({ shell_pid: 3 }) }, deps(() => Promise.reject(new Error("ENOENT"))));
    const result = await live.probe("w1:p1", settings);
    assert.deepEqual(result, { ok: false, reason: "ENOENT" });
  });
});
