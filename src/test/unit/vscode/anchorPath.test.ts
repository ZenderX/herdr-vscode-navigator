import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { isLegacyAnchor, selectAnchor } from "../../../vscode/anchorPath";

describe("legacy anchor adoption", () => {
  it("adopts a sibling publisher's anchor only from index 0 of the same globalStorage parent", () => {
    const winStorage = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\z3nder.herdr-navigator";
    const winLegacy = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\old.herdr-navigator\\anchor";
    const own = `${winStorage}\\anchor`;
    assert.equal(isLegacyAnchor(winLegacy.toLowerCase(), winStorage, "win32"), true);
    assert.equal(isLegacyAnchor("C:\\work\\x.herdr-navigator\\anchor", winStorage, "win32"), false);
    assert.equal(isLegacyAnchor(winLegacy.replace(".herdr-navigator", ".other"), winStorage, "win32"), false);
    const posixStorage = "/home/me/.config/Code/User/globalStorage/z3nder.herdr-navigator";
    assert.equal(isLegacyAnchor("/home/me/.config/Code/User/globalStorage/old.herdr-navigator/anchor", posixStorage, "linux"), true);
    assert.equal(isLegacyAnchor("/home/me/.config/Code/User/GlobalStorage/old.herdr-navigator/anchor", posixStorage, "linux"), false);

    assert.deepEqual(selectAnchor(winLegacy, own, winStorage, "win32"), { path: winLegacy, adopted: true });
    assert.deepEqual(selectAnchor(own.toLowerCase(), own, winStorage, "win32"), { path: own, adopted: false });
    assert.deepEqual(selectAnchor("C:\\work\\repo", own, winStorage, "win32"), { path: own, adopted: false });
  });
});
