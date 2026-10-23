import assert from "node:assert/strict";
import { executableCandidates, resolveOnPath } from "../../../launch/whichHerdr";

describe("executableCandidates", () => {
  it("win32 tries each PATHEXT extension then the bare name per directory, honouring Path spelling and quoted entries", () => {
    assert.deepEqual(executableCandidates("herdr", { PATH: '"C:\\Program Files\\x";;C:\\b' }, "win32"), [
      "C:\\Program Files\\x\\herdr.com",
      "C:\\Program Files\\x\\herdr.exe",
      "C:\\Program Files\\x\\herdr.bat",
      "C:\\Program Files\\x\\herdr.cmd",
      "C:\\Program Files\\x\\herdr",
      "C:\\b\\herdr.com",
      "C:\\b\\herdr.exe",
      "C:\\b\\herdr.bat",
      "C:\\b\\herdr.cmd",
      "C:\\b\\herdr",
    ]);
    assert.deepEqual(executableCandidates("herdr", { Path: "C:\\a", pathext: ".EXE;.PS1" }, "win32"), ["C:\\a\\herdr.exe", "C:\\a\\herdr.ps1", "C:\\a\\herdr"]);
  });
});

describe("resolveOnPath", () => {
  it("returns the first hit in PATH order on linux and darwin, and undefined when nothing matches", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      assert.equal(await resolveOnPath("herdr", platform, { PATH: "/a:/b" }, async () => true), "/a/herdr");
      assert.equal(await resolveOnPath("herdr", platform, { PATH: "/a:/b" }, async () => false), undefined);
      assert.equal(await resolveOnPath("herdr", platform, { Path: "/a" }, async () => true), undefined);
    }
  });
});
