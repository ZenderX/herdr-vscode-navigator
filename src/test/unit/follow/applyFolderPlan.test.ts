import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { applyFolderPlan, applyPendingTakeover } from "../../../follow/applyFolderPlan";
import type { HostingHandoff, PlanEffects } from "../../../follow/applyFolderPlan";
import { planFolders } from "../../../follow/planFolders";

const ANCHOR = "C:\\storage\\anchor";
const PROJECT = "C:\\work\\project";
const TARGET = "C:\\work\\target";

function setup(folders: string[], hosts: boolean): { calls: string[]; effects: PlanEffects; handoff: HostingHandoff } {
  const calls: string[] = [];
  return {
    calls,
    effects: {
      openFolders: () => folders,
      convert: (anchor, target) => Promise.resolve(void calls.push(`convert ${anchor} ${target}`)).then(() => true),
      updateFolders: (kind, start, deleteCount, add) =>
        Promise.resolve(void calls.push(`update ${kind} ${start} ${deleteCount} ${add.join(",")}`)).then(() => true),
    },
    handoff: {
      hostsHerdr: () => hosts,
      beginHostingConversion: (folder) => Promise.resolve(void calls.push(`begin ${folder}`)),
      recordTakeover: (folder) => Promise.resolve(void calls.push(`record ${folder}`)),
    },
  };
}

const apply = (folders: string[], hosts: boolean, plan: Parameters<typeof applyFolderPlan>[0]): ReturnType<typeof setup> & { done: Promise<boolean> } => {
  const s = setup(folders, hosts);
  return { ...s, done: applyFolderPlan(plan, s.effects, s.handoff, "win32", () => undefined) };
};

describe("applyPendingTakeover", () => {
  const MAX = 120_000;
  const NOW = 1_000_000;
  const fresh = { folder: TARGET, at: NOW - 1000 };
  const run = (folders: string[], pending: Parameters<typeof applyPendingTakeover>[0]): ReturnType<typeof setup> & { done: Promise<string | undefined>; logs: string[] } => {
    const s = setup(folders, false);
    const logs: string[] = [];
    return { ...s, logs, done: applyPendingTakeover(pending, NOW, MAX, s.effects, "win32", (_level, line) => void logs.push(line)) };
  };

  it("replaces slot 1 once with the takeover folder", async () => {
    const s = run([ANCHOR, PROJECT], fresh);
    assert.equal(await s.done, TARGET);
    assert.deepEqual(s.calls, [`update replace 1 1 ${TARGET}`]);
  });

  it("does nothing when slot 1 already holds the folder", async () => {
    const s = run([ANCHOR, TARGET], fresh);
    assert.equal(await s.done, TARGET);
    assert.deepEqual(s.calls, []);
    assert.match(s.logs.join("\n"), /plan: noop/);
  });

  it("keeps folders the user added after slot 1", async () => {
    const s = run([ANCHOR, PROJECT, "C:\\work\\extra"], fresh);
    await s.done;
    assert.deepEqual(s.calls, [`update replace 1 1 ${TARGET}`]);
  });

  it("appends in slot 1 when only the anchor is open", async () => {
    const s = run([ANCHOR], fresh);
    await s.done;
    assert.deepEqual(s.calls, [`update append 1 0 ${TARGET}`]);
  });

  it("ignores a stale takeover", async () => {
    const s = run([ANCHOR, PROJECT], { folder: TARGET, at: NOW - MAX - 1 });
    assert.equal(await s.done, undefined);
    assert.deepEqual(s.calls, []);
  });

  it("ignores a record with no takeover", async () => {
    const s = run([ANCHOR, PROJECT], { at: NOW });
    assert.equal(await s.done, undefined);
    assert.deepEqual(s.calls, []);
  });

  it("never touches index 0", async () => {
    for (const folders of [[ANCHOR], [ANCHOR, PROJECT], [ANCHOR, PROJECT, "C:\\work\\extra"]]) {
      const s = run(folders, fresh);
      await s.done;
      assert.ok(s.calls.every((call) => /^update \w+ 1 /.test(call)), s.calls.join());
    }
  });
});

describe("applyFolderPlan", () => {
  const convert = planFolders({ folders: [{ path: PROJECT }], trackedPath: null, anchorPath: ANCHOR, target: TARGET, isMultiRoot: false, platform: "win32" });

  it("records the pending takeover before a hosting plain window converts", async () => {
    const s = apply([PROJECT], true, convert);
    assert.equal(await s.done, true);
    assert.deepEqual(s.calls, [`begin ${TARGET}`, `convert ${ANCHOR} ${TARGET}`]);
  });

  it("records the takeover folder without hosting handoff when the converting window does not host herdr", async () => {
    const s = apply([PROJECT], false, convert);
    await s.done;
    assert.deepEqual(s.calls, [`record ${TARGET}`, `convert ${ANCHOR} ${TARGET}`]);
  });

  it("follows in a saved navigator with the index-1 replace only, never a conversion or hosting handoff", async () => {
    const folders = [ANCHOR, PROJECT];
    const plan = planFolders({ folders: folders.map((path) => ({ path })), trackedPath: PROJECT, anchorPath: ANCHOR, target: TARGET, isMultiRoot: true, platform: "win32" });
    const s = apply(folders, true, plan);
    assert.equal(await s.done, true);
    assert.deepEqual(s.calls, [`update replace 1 1 ${TARGET}`]);
  });
});
