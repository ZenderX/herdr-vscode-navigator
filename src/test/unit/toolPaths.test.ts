import * as assert from "node:assert/strict";
import { createToolResolver } from "../../toolPaths";
import type { ToolPathDeps } from "../../toolPaths";

const exists = (...present: string[]) => (path: string) => present.includes(path);
const WIN_PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function resolver(platform: NodeJS.Platform, present: string[], env: ToolPathDeps["env"] = {}) {
  return createToolResolver({ platform, env, exists: exists(...present) });
}

describe("createToolResolver", () => {
  it("resolves system tools to their absolute system path, falling back to the bare name only when missing", () => {
    const custom = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    assert.equal(resolver("win32", [custom], { SystemRoot: "D:\\Win" })("powershell"), custom);
    assert.equal(resolver("win32", [WIN_PS])("powershell"), WIN_PS);
    assert.equal(resolver("win32", [])("powershell"), "powershell.exe");
    assert.equal(resolver("darwin", ["/bin/ps", "/usr/sbin/lsof"])("lsof"), "/usr/sbin/lsof");
    assert.equal(resolver("linux", ["/usr/bin/ps"])("ps"), "/usr/bin/ps");
    assert.equal(resolver("linux", [])("ps"), "ps");
  });
});
