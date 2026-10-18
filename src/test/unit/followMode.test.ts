import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "mocha";
import { DEFAULT_FOLLOW_MODE, parseFollowMode } from "../../vscode/followMode";
import { anchorDirPath } from "../../vscode/anchorPath";

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
