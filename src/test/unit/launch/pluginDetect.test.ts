import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { detectRefocusPlugin, REFOCUS_PLUGIN_ID } from "../../../launch/pluginDetect";

const entry = { plugin_id: REFOCUS_PLUGIN_ID, enabled: true, name: "Refocus" };

describe("detectRefocusPlugin", () => {
  it("runs herdr plugin list --json and reports an enabled plugin present, a disabled one absent, and any failure unknown", async () => {
    const calls: unknown[][] = [];
    const listing = (plugins: unknown[]) => (file: string, args: readonly string[], timeout: number) => {
      calls.push([file, args, timeout]);
      return Promise.resolve({ stdout: JSON.stringify({ id: "cli:plugin", result: { plugins, type: "plugin_list" } }) });
    };
    assert.equal(await detectRefocusPlugin(listing([entry]), "C:\\bin\\herdr.exe"), "present");
    assert.deepEqual(calls[0], ["C:\\bin\\herdr.exe", ["plugin", "list", "--json"], 3000]);
    assert.equal(await detectRefocusPlugin(listing([{ ...entry, enabled: false }]), "herdr"), "absent");
    assert.equal(await detectRefocusPlugin(listing([{ plugin_id: "other.plugin", enabled: true }]), "herdr"), "absent");
    assert.equal(await detectRefocusPlugin(() => Promise.reject(new Error("timed out")), "herdr"), "unknown");
    assert.equal(await detectRefocusPlugin(() => Promise.resolve({ stdout: "{" }), "herdr"), "unknown");
  });
});
