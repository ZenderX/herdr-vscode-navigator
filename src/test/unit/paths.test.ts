import assert from "node:assert/strict";
import { isSameOrInside as isSameOrInsideOn, normalizeCwd as normalizeCwdOn, samePath as samePathOn } from "../../paths";

// Tests default to win32 explicitly so they run identically on any host.
const normalizeCwd = (input: string | null | undefined, platform: NodeJS.Platform = "win32") => normalizeCwdOn(input, platform);
const samePath = (a: string | null | undefined, b: string | null | undefined, platform: NodeJS.Platform = "win32") =>
  samePathOn(a, b, platform);
const isSameOrInside = (child: string | null | undefined, parent: string | null | undefined, platform: NodeJS.Platform = "win32") =>
  isSameOrInsideOn(child, parent, platform);

describe("normalizeCwd, samePath and isSameOrInside", () => {
  it("map every cwd form to one absolute path per platform, compare with the platform's case rule, and contain only on a path boundary", () => {
    // win32: MSYS, cygdrive, forward-slash and UNC forms map to one Windows path; relative or rootless input is rejected.
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

    // POSIX: dots and trailing slashes normalize, /c/ never maps to a drive, and only linux compares case-sensitively.
    assert.equal(normalizeCwd("/home/u/a/../x//", "darwin"), "/home/u/x");
    assert.equal(normalizeCwd("/", "linux"), "/");
    assert.equal(normalizeCwd("/c/foo", "linux"), "/c/foo");
    assert.equal(normalizeCwd("C:\\foo", "linux"), null);
    assert.equal(samePath("/home/u/x", "/home/u/x/", "linux"), true);
    assert.equal(samePath("/home/u/X", "/home/u/x", "linux"), false);
    assert.equal(samePath("/Users/u/X", "/users/u/x", "darwin"), true);

    // Containment: a sibling sharing a name prefix must not count as inside, or its repository would be kept.
    const parent = "C:\\Users\\me\\Projects\\parentdir";
    assert.equal(isSameOrInside(parent, parent), true);
    assert.equal(isSameOrInside(`${parent}\\nestedrepo`, parent), true);
    assert.equal(isSameOrInside(`${parent}2`, parent), false);
    assert.equal(isSameOrInside(`${parent}2\\nestedrepo`, parent), false);
    assert.equal(isSameOrInside(parent, `${parent}\\nestedrepo`), false);
    assert.equal(isSameOrInside("c:\\users\\me\\projects\\PARENTDIR\\nestedrepo", parent), true);
    assert.equal(isSameOrInside(`${parent}\\`, parent), true);
    assert.equal(isSameOrInside(`${parent}\\nestedrepo\\`, `${parent}\\`), true);
    assert.equal(isSameOrInside("C:\\", "C:\\"), true);
    assert.equal(isSameOrInside("c:\\foo", "C:\\"), true);
    assert.equal(isSameOrInside("D:\\foo", "C:\\"), false);
    assert.equal(isSameOrInside("\\\\server\\share\\x", "\\\\server\\share"), true);
    assert.equal(isSameOrInside("\\\\server\\share2\\x", "\\\\server\\share"), false);
    assert.equal(isSameOrInside("/", "/", "linux"), true);
    assert.equal(isSameOrInside("/home/u", "/", "linux"), true);
    assert.equal(isSameOrInside("/home/parentdir2", "/home/parentdir/", "linux"), false);
    assert.equal(isSameOrInside("/home/PARENTDIR/x", "/home/parentdir", "linux"), false);
    assert.equal(isSameOrInside("/Users/U/x", "/users/u", "darwin"), true);
    for (const [child, parentPath] of [["rel", "rel"], [null, parent], [parent, undefined]] as const) assert.equal(isSameOrInside(child, parentPath), false);
  });
});
