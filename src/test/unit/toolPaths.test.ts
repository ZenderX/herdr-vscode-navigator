import * as assert from "node:assert/strict";
import { createToolResolver } from "../../toolPaths";
import type { ToolPathDeps } from "../../toolPaths";

const exists = (...present: string[]) => (path: string) => present.includes(path);
const WIN_PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function resolver(platform: NodeJS.Platform, present: string[], env: ToolPathDeps["env"] = {}) {
  return createToolResolver({ platform, env, exists: exists(...present) });
}

describe("createToolResolver", () => {
  it("win32: uses SystemRoot when set, defaults to C:\\Windows, falls back to the bare name when missing", () => {
    const custom = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    assert.equal(resolver("win32", [custom], { SystemRoot: "D:\\Win" })("powershell"), custom);
    assert.equal(resolver("win32", [WIN_PS])("powershell"), WIN_PS);
    assert.equal(resolver("win32", [], { SystemRoot: "D:\\Win" })("powershell"), "powershell.exe");
  });

  it("darwin: /bin/ps and /usr/sbin/lsof when present, bare names when missing", () => {
    assert.equal(resolver("darwin", ["/bin/ps", "/usr/sbin/lsof"])("ps"), "/bin/ps");
    assert.equal(resolver("darwin", ["/bin/ps", "/usr/sbin/lsof"])("lsof"), "/usr/sbin/lsof");
    assert.equal(resolver("darwin", [])("ps"), "ps");
    assert.equal(resolver("darwin", [])("lsof"), "lsof");
  });

  it("linux: /bin/ps, else /usr/bin/ps, else ps", () => {
    assert.equal(resolver("linux", ["/bin/ps", "/usr/bin/ps"])("ps"), "/bin/ps");
    assert.equal(resolver("linux", ["/usr/bin/ps"])("ps"), "/usr/bin/ps");
    assert.equal(resolver("linux", [])("ps"), "ps");
  });

  it("memoizes per tool and logs a missing tool once", () => {
    let checks = 0;
    const logs: string[] = [];
    const resolve = createToolResolver({
      platform: "linux",
      env: {},
      exists: () => {
        checks += 1;
        return false;
      },
      log: (_level, msg) => logs.push(msg),
    });
    assert.equal(resolve("ps"), "ps");
    assert.equal(resolve("ps"), "ps");
    assert.equal(checks, 2, "both candidates checked on the first call only");
    assert.equal(logs.length, 1);
  });
});
