import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "mocha";
import { DEFAULT_FOLLOW_MODE, parseFollowMode } from "../../vscode/followMode";
import { anchorDirPath, isLegacyAnchor, selectAnchor } from "../../vscode/anchorPath";

describe("parseFollowMode", () => {
  it("accepts folder", () => assert.equal(parseFollowMode("folder"), "folder"));
  it("accepts workspace", () => assert.equal(parseFollowMode("workspace"), "workspace"));
  it("falls back to the default for an invalid value", () => {
    assert.equal(parseFollowMode("multi"), DEFAULT_FOLLOW_MODE);
    assert.equal(parseFollowMode(3), DEFAULT_FOLLOW_MODE);
  });
  it("falls back to the default when missing", () => assert.equal(parseFollowMode(undefined), DEFAULT_FOLLOW_MODE));
  it("defaults to workspace, matching package.json", () => {
    assert.equal(DEFAULT_FOLLOW_MODE, "workspace");
  });
});

describe("anchorDirPath", () => {
  it("is a directory under global storage, never the storage root or a user folder", () => {
    const storage = path.join(path.sep, "gs", "ext");
    const anchor = anchorDirPath(storage);
    assert.equal(path.dirname(anchor), storage);
    assert.notEqual(anchor, storage);
  });
});

describe("legacy anchor adoption", () => {
  const winStorage = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\z3nder.herdr-navigator";
  const winLegacy = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\old.herdr-navigator\\anchor";
  const posixStorage = "/home/me/.config/Code/User/globalStorage/z3nder.herdr-navigator";
  const posixLegacy = "/home/me/.config/Code/User/globalStorage/old.herdr-navigator/anchor";

  it("adopts a sibling publisher's anchor on win32, ignoring drive and segment case", () => {
    assert.equal(isLegacyAnchor(winLegacy, winStorage, "win32"), true);
    assert.equal(isLegacyAnchor(winLegacy.toLowerCase(), winStorage, "win32"), true);
  });

  it("adopts a sibling publisher's anchor on linux", () => {
    assert.equal(isLegacyAnchor(posixLegacy, posixStorage, "linux"), true);
  });

  it("is case-sensitive on linux", () => {
    assert.equal(isLegacyAnchor("/home/me/.config/Code/User/GlobalStorage/old.herdr-navigator/anchor", posixStorage, "linux"), false);
  });

  it("rejects a look-alike outside the globalStorage parent", () => {
    assert.equal(isLegacyAnchor("C:\\work\\x.herdr-navigator\\anchor", winStorage, "win32"), false);
    assert.equal(isLegacyAnchor("/work/x.herdr-navigator/anchor", posixStorage, "linux"), false);
  });

  it("rejects a basename other than anchor, and an id directory without the suffix", () => {
    assert.equal(isLegacyAnchor(winLegacy.replace("anchor", "other"), winStorage, "win32"), false);
    assert.equal(isLegacyAnchor(winLegacy.replace(".herdr-navigator", ".other"), winStorage, "win32"), false);
  });

  it("selects the own anchor when it is at index 0", () => {
    const own = `${winStorage}\\anchor`;
    assert.deepEqual(selectAnchor(own.toLowerCase(), own, winStorage, "win32"), { path: own, adopted: false });
  });

  it("adopts the legacy anchor only from index 0 and falls back to the own anchor otherwise", () => {
    const own = `${winStorage}\\anchor`;
    assert.deepEqual(selectAnchor(winLegacy, own, winStorage, "win32"), { path: winLegacy, adopted: true });
    assert.deepEqual(selectAnchor("C:\\work\\repo", own, winStorage, "win32"), { path: own, adopted: false });
    assert.deepEqual(selectAnchor(undefined, own, winStorage, "win32"), { path: own, adopted: false });
  });
});
