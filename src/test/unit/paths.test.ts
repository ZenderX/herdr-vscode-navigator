import assert from "node:assert/strict";
import { normalizeCwd as normalizeCwdOn, samePath as samePathOn } from "../../paths";

// Tests default to win32 explicitly so they run identically on any host.
const normalizeCwd = (input: string | null | undefined, platform: NodeJS.Platform = "win32") => normalizeCwdOn(input, platform);
const samePath = (a: string | null | undefined, b: string | null | undefined, platform: NodeJS.Platform = "win32") =>
  samePathOn(a, b, platform);

describe("normalizeCwd", () => {
  it("converts MSYS drive paths", () => {
    assert.equal(normalizeCwd("/c/foo/bar"), "C:\\foo\\bar");
    assert.equal(normalizeCwd("/C/foo"), "C:\\foo");
    assert.equal(normalizeCwd("/c"), "C:\\");
  });

  it("converts cygdrive paths", () => {
    assert.equal(normalizeCwd("/cygdrive/c/foo"), "C:\\foo");
  });

  it("converts forward-slash Windows paths", () => {
    assert.equal(normalizeCwd("C:/foo"), "C:\\foo");
  });

  it("uppercases the drive letter of backslash paths", () => {
    assert.equal(normalizeCwd("c:\\foo"), "C:\\foo");
  });

  it("keeps UNC paths in either slash form", () => {
    assert.equal(normalizeCwd("//server/share/x"), "\\\\server\\share\\x");
    assert.equal(normalizeCwd("\\\\server\\share\\x"), "\\\\server\\share\\x");
  });

  it("strips trailing separators except on a drive root", () => {
    assert.equal(normalizeCwd("C:\\Users\\me\\"), "C:\\Users\\me");
    assert.equal(normalizeCwd("/c/foo/"), "C:\\foo");
    assert.equal(normalizeCwd("C:\\"), "C:\\");
    assert.equal(normalizeCwd("C:/"), "C:\\");
  });

  it("rejects relative and rootless input", () => {
    assert.equal(normalizeCwd("foo/bar"), null);
    assert.equal(normalizeCwd("..\\foo"), null);
    assert.equal(normalizeCwd("C:foo"), null);
    assert.equal(normalizeCwd("/"), null);
    assert.equal(normalizeCwd("/home/user"), null);
  });

  it("returns null for null, undefined, empty, and blank input", () => {
    assert.equal(normalizeCwd(null), null);
    assert.equal(normalizeCwd(undefined), null);
    assert.equal(normalizeCwd(""), null);
    assert.equal(normalizeCwd("   "), null);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeCwd("  /c/foo  "), "C:\\foo");
  });
});

describe("POSIX paths", () => {
  it("normalizes dots and trailing slashes but keeps the root", () => {
    assert.equal(normalizeCwd("/home/u/x/", "linux"), "/home/u/x");
    assert.equal(normalizeCwd("/home/u/a/../x//", "darwin"), "/home/u/x");
    assert.equal(normalizeCwd("/", "linux"), "/");
  });

  it("rejects relative and Windows-style paths, and never maps /c/ to a drive", () => {
    assert.equal(normalizeCwd("home/u", "linux"), null);
    assert.equal(normalizeCwd("C:\\foo", "linux"), null);
    assert.equal(normalizeCwd("/c/foo", "linux"), "/c/foo");
  });

  it("compares case-sensitively on linux and case-insensitively on darwin", () => {
    assert.equal(samePath("/home/u/x", "/home/u/x/", "linux"), true);
    assert.equal(samePath("/home/u/X", "/home/u/x", "linux"), false);
    assert.equal(samePath("/Users/u/X", "/users/u/x", "darwin"), true);
  });

  it("keeps Windows rules on win32", () => {
    assert.equal(samePath("/home/u/x", "/home/u/x", "win32"), false);
    assert.equal(samePath("c:\\A", "C:\\a\\", "win32"), true);
  });
});

describe("samePath", () => {
  it("matches across forms and case", () => {
    assert.equal(samePath("/c/Users/Me", "c:\\users\\me\\"), true);
  });

  it("differs for different paths", () => {
    assert.equal(samePath("C:\\a", "C:\\b"), false);
  });

  it("is false when either side is not normalizable", () => {
    assert.equal(samePath("rel", "rel"), false);
    assert.equal(samePath(null, "C:\\a"), false);
  });
});
