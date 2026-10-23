import assert from "node:assert/strict";
import { normalizeCwd as normalizeCwdOn, samePath as samePathOn } from "../../paths";

// Tests default to win32 explicitly so they run identically on any host.
const normalizeCwd = (input: string | null | undefined, platform: NodeJS.Platform = "win32") => normalizeCwdOn(input, platform);
const samePath = (a: string | null | undefined, b: string | null | undefined, platform: NodeJS.Platform = "win32") =>
  samePathOn(a, b, platform);

describe("normalizeCwd and samePath on win32", () => {
  it("maps MSYS, cygdrive, forward-slash and UNC forms to one Windows path, and rejects relative or rootless input", () => {
    assert.equal(normalizeCwd("/c/foo/bar"), "C:\\foo\\bar");
    assert.equal(normalizeCwd("/c"), "C:\\");
    assert.equal(normalizeCwd("/cygdrive/c/foo"), "C:\\foo");
    assert.equal(normalizeCwd("C:/foo"), "C:\\foo");
    assert.equal(normalizeCwd("c:\\foo"), "C:\\foo");
    assert.equal(normalizeCwd("//server/share/x"), "\\\\server\\share\\x");
    assert.equal(normalizeCwd("\\\\server\\share\\x"), "\\\\server\\share\\x");
    assert.equal(normalizeCwd("  C:\\Users\\me\\  "), "C:\\Users\\me");
    assert.equal(normalizeCwd("C:/"), "C:\\");
    for (const input of ["foo/bar", "..\\foo", "C:foo", "/", "/home/user", "", null]) assert.equal(normalizeCwd(input), null, String(input));
    assert.equal(samePath("/c/Users/Me", "c:\\users\\me\\"), true);
    assert.equal(samePath("C:\\a", "C:\\b"), false);
    assert.equal(samePath("rel", "rel"), false);
  });
});

describe("POSIX paths", () => {
  it("normalize dots and trailing slashes, never map /c/ to a drive, and compare case-sensitively only on linux", () => {
    assert.equal(normalizeCwd("/home/u/a/../x//", "darwin"), "/home/u/x");
    assert.equal(normalizeCwd("/", "linux"), "/");
    assert.equal(normalizeCwd("/c/foo", "linux"), "/c/foo");
    assert.equal(normalizeCwd("C:\\foo", "linux"), null);
    assert.equal(samePath("/home/u/x", "/home/u/x/", "linux"), true);
    assert.equal(samePath("/home/u/X", "/home/u/x", "linux"), false);
    assert.equal(samePath("/Users/u/X", "/users/u/x", "darwin"), true);
  });
});
