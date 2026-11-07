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
        Promise.resolve(
          void calls.push(`update ${kind} ${start} ${deleteCount} ${add.map(({ path, name }) => (name === undefined ? path : `${path} as ${name}`)).join(",")}`),
        ).then(() => true),
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

  it("moves a fresh takeover folder into slot 1 in one change, removing every other folder after index 0, leaves it where it already holds slot 1, and ignores a stale one", async () => {
    const replaced = run([ANCHOR, PROJECT, "C:\\work\\extra"], fresh);
    assert.equal(await replaced.done, TARGET);
    assert.deepEqual(replaced.calls, [`update reclaim 1 2 ${TARGET}`]);
    const later = run([ANCHOR, PROJECT, TARGET], fresh);
    assert.equal(await later.done, TARGET);
    assert.deepEqual(later.calls, [`update reclaim 1 2 ${TARGET}`]);
    const holding = run([ANCHOR, TARGET, PROJECT], fresh);
    assert.equal(await holding.done, TARGET);
    assert.deepEqual(holding.calls, []);
    const inPlace = run([ANCHOR, PROJECT], fresh);
    await inPlace.done;
    assert.deepEqual(inPlace.calls, [`update replace 1 1 ${TARGET}`]);
    const appended = run([ANCHOR], fresh);
    await appended.done;
    assert.deepEqual(appended.calls, [`update append 1 0 ${TARGET}`]);
    const named = run([ANCHOR, PROJECT], { ...fresh, name: "mainproj" });
    assert.equal(await named.done, TARGET);
    assert.deepEqual(named.calls, [`update replace 1 1 ${TARGET} as mainproj`]);
    const held = run([ANCHOR, TARGET], fresh);
    assert.equal(await held.done, TARGET);
    assert.deepEqual(held.calls, []);
    const stale = run([ANCHOR, PROJECT], { folder: TARGET, at: NOW - MAX - 1 });
    assert.equal(await stale.done, undefined);
    assert.deepEqual(stale.calls, []);
  });
});

describe("applyFolderPlan", () => {
  it("records the takeover before a plain window converts, and follows a saved navigator with the index-1 replace only", async () => {
    const convert = planFolders({ folders: [{ path: PROJECT }], trackedPath: null, anchorPath: ANCHOR, target: TARGET, isMultiRoot: false, platform: "win32" });
    const hosting = apply([PROJECT], true, convert);
    assert.equal(await hosting.done, true);
    assert.deepEqual(hosting.calls, [`begin ${TARGET}`, `convert ${ANCHOR} ${TARGET}`]);
    const plain = apply([PROJECT], false, convert);
    await plain.done;
    assert.deepEqual(plain.calls, [`record ${TARGET}`, `convert ${ANCHOR} ${TARGET}`]);

    const folders = [ANCHOR, PROJECT];
    const plan = planFolders({ folders: folders.map((path) => ({ path })), trackedPath: PROJECT, anchorPath: ANCHOR, target: TARGET, isMultiRoot: true, platform: "win32" });
    const s = apply(folders, true, plan);
    assert.equal(await s.done, true);
    assert.deepEqual(s.calls, [`update replace 1 1 ${TARGET}`]);

    // The rename re-adds the open slot's own path, which the mutation must not drop as already present.
    const slot = [ANCHOR, TARGET];
    const rename = planFolders({ folders: [{ path: ANCHOR }, { path: TARGET, name: "target" }], trackedPath: TARGET, anchorPath: ANCHOR, target: TARGET, targetName: "mainproj", isMultiRoot: true, platform: "win32" });
    const renamed = apply(slot, true, rename);
    assert.equal(await renamed.done, true);
    assert.deepEqual(renamed.calls, [`update replace 1 1 ${TARGET} as mainproj`]);
  });
});
