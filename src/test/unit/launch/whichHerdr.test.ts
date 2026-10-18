import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableCandidates, resolveOnPath } from "../../../launch/whichHerdr";

const platforms: NodeJS.Platform[] = ["win32", "linux", "darwin"];

describe("executableCandidates", () => {
  it("win32 appends default PATHEXT then the bare name per directory", () => {
    const env = { PATH: "C:\\a;;C:\\b" };
    assert.deepEqual(executableCandidates("herdr", env, "win32"), [
      "C:\\a\\herdr.com",
      "C:\\a\\herdr.exe",
      "C:\\a\\herdr.bat",
      "C:\\a\\herdr.cmd",
      "C:\\a\\herdr",
      "C:\\b\\herdr.com",
      "C:\\b\\herdr.exe",
      "C:\\b\\herdr.bat",
      "C:\\b\\herdr.cmd",
      "C:\\b\\herdr",
    ]);
  });

  it("win32 honours a custom PATHEXT and the Path key spelling", () => {
    const env = { Path: "C:\\a", pathext: ".EXE;.PS1" };
    assert.deepEqual(executableCandidates("herdr", env, "win32"), ["C:\\a\\herdr.exe", "C:\\a\\herdr.ps1", "C:\\a\\herdr"]);
  });

  it("linux and darwin split on colon and try only the bare name", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const env = { PATH: "/usr/bin::/opt/bin", PATHEXT: ".EXE" };
      assert.deepEqual(executableCandidates("herdr", env, platform), ["/usr/bin/herdr", "/opt/bin/herdr"]);
    }
  });

  it("win32 strips one pair of surrounding quotes from a PATH entry", () => {
    const env = { PATH: '"C:\\Program Files\\x";C:\\b', PATHEXT: ".EXE" };
    assert.deepEqual(executableCandidates("herdr", env, "win32"), [
      "C:\\Program Files\\x\\herdr.exe",
      "C:\\Program Files\\x\\herdr",
      "C:\\b\\herdr.exe",
      "C:\\b\\herdr",
    ]);
  });

  it("posix env keys are case-sensitive", () => {
    assert.deepEqual(executableCandidates("herdr", { Path: "/usr/bin" }, "linux"), []);
  });

  it("returns nothing for a missing PATH on every platform", () => {
    for (const platform of platforms) assert.deepEqual(executableCandidates("herdr", {}, platform), []);
  });
});

describe("resolveOnPath", () => {
  it("win32 resolves a PATHEXT hit", async () => {
    const hit = "C:\\b\\herdr.exe";
    const found = await resolveOnPath("herdr", "win32", { Path: "C:\\a;C:\\b" }, async (p) => p === hit);
    assert.equal(found, hit);
  });

  it("win32 resolves a bare-name hit", async () => {
    const hit = "C:\\a\\herdr";
    const found = await resolveOnPath("herdr", "win32", { PATH: "C:\\a" }, async (p) => p === hit);
    assert.equal(found, hit);
  });

  it("linux and darwin return the first hit in PATH order", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const found = await resolveOnPath("herdr", platform, { PATH: "/a:/b" }, async () => true);
      assert.equal(found, "/a/herdr");
    }
  });

  it("returns undefined when nothing is found on any platform", async () => {
    for (const platform of platforms) {
      const env = { PATH: platform === "win32" ? "C:\\a" : "/a", Path: undefined };
      assert.equal(await resolveOnPath("herdr", platform, env, async () => false), undefined);
    }
  });

  it("returns undefined without a PATH", async () => {
    for (const platform of platforms) assert.equal(await resolveOnPath("herdr", platform, {}, async () => true), undefined);
  });

  it("default probe rejects a directory named like the executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-probe-"));
    try {
      mkdirSync(join(root, "herdr"));
      assert.equal(await resolveOnPath("herdr", "linux", { PATH: root }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default probe finds nothing for a nonexistent directory", async () => {
    const dir = process.platform === "win32" ? "C:\\nonexistent-herdr-dir" : "/nonexistent-herdr-dir";
    assert.equal(await resolveOnPath("herdr", process.platform, { PATH: dir }), undefined);
  });
});
