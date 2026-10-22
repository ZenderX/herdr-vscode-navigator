import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { detectRefocusPlugin, parsePluginList, REFOCUS_PLUGIN_ID } from "../../../launch/pluginDetect";

const entry = { plugin_id: REFOCUS_PLUGIN_ID, enabled: true, name: "Refocus" };

describe("parsePluginList", () => {
  it("reads the shape herdr prints: result.plugins with plugin_id", () => {
    assert.equal(parsePluginList(JSON.stringify({ id: "cli:plugin", result: { plugins: [entry], type: "plugin_list" } })), "present");
  });

  it("reads a bare array and a plugins object, matching on id as well", () => {
    assert.equal(parsePluginList(JSON.stringify([entry])), "present");
    assert.equal(parsePluginList(JSON.stringify({ plugins: [{ id: REFOCUS_PLUGIN_ID }] })), "present");
  });

  it("treats a disabled plugin as absent but an entry without an enabled field as present", () => {
    assert.equal(parsePluginList(JSON.stringify([{ ...entry, enabled: false }])), "absent");
    assert.equal(parsePluginList(JSON.stringify([{ plugin_id: REFOCUS_PLUGIN_ID }])), "present");
  });

  it("is absent when only other plugins are listed", () => {
    assert.equal(parsePluginList(JSON.stringify([{ plugin_id: "other.plugin", enabled: true }])), "absent");
  });

  it("is unknown for unparsable or unrecognised output", () => {
    assert.equal(parsePluginList("not json"), "unknown");
    assert.equal(parsePluginList(JSON.stringify({ result: {} })), "unknown");
    assert.equal(parsePluginList("42"), "unknown");
  });
});

describe("detectRefocusPlugin", () => {
  it("runs the resolved binary with plugin list --json and a timeout", async () => {
    const calls: unknown[][] = [];
    const state = await detectRefocusPlugin(
      (file, args, timeout) => {
        calls.push([file, args, timeout]);
        return Promise.resolve({ stdout: JSON.stringify([entry]) });
      },
      "C:\\bin\\herdr.exe",
    );
    assert.equal(state, "present");
    assert.deepEqual(calls, [["C:\\bin\\herdr.exe", ["plugin", "list", "--json"], 3000]]);
  });

  it("is unknown when the call fails (spawn error, timeout, non-zero exit)", async () => {
    assert.equal(await detectRefocusPlugin(() => Promise.reject(new Error("timed out")), "herdr"), "unknown");
  });

  it("is unknown for bad JSON", async () => {
    assert.equal(await detectRefocusPlugin(() => Promise.resolve({ stdout: "{" }), "herdr"), "unknown");
  });
});
