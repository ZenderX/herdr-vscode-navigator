import assert from "node:assert/strict";
import { decideScm, guardToggles, initOffer } from "../../../scm/decision";
import type { LoopGuardDecision, ScmDecision, ToggleAttempt } from "../../../scm/decision";

const ANCHOR = "C:\\Users\\me\\AppData\\anchor";
const PROJECTS = "C:\\Users\\me\\Projects";
const PARENT = `${PROJECTS}\\parentdir`;
const NESTED = `${PARENT}\\nestedrepo`;
const OUTSIDE = `${PROJECTS}\\otherrepo`;
const FOLDERS = [ANCHOR, PARENT];

// Tests default to win32 explicitly so they run identically on any host.
const decide = (roots: string[], folders: string[] = FOLDERS, platform: NodeJS.Platform = "win32"): ScmDecision => decideScm({ folders, roots, platform });
const guard = (strays: string[], history: ToggleAttempt[], survived: string[], at: number, platform: NodeJS.Platform = "win32"): LoopGuardDecision =>
  guardToggles({ strays, history, survived, now: () => at, platform });

describe("decideScm, guardToggles and initOffer", () => {
  it("keeps exactly the selected space's repository with no left-open outcome, holds a stray only while a toggle cannot work, and offers Initialize only for a followed folder", () => {
    // The followed folder's own repository, or one above it, is what the user selected; a case or separator difference is still that repository.
    assert.deepEqual(decide([]), { owned: null, strays: [] });
    assert.deepEqual(decide([PARENT]), { owned: PARENT, strays: [] });
    assert.deepEqual(decide([PROJECTS]), { owned: PROJECTS, strays: [] });
    const respelled = "c:\\users\\ME\\projects\\PARENTDIR\\";
    assert.deepEqual(decide([respelled]), { owned: respelled, strays: [] });

    // A repository nested under the followed root is never the selected one, whether or not the space has its own.
    assert.deepEqual(decide([PARENT, NESTED]), { owned: PARENT, strays: [NESTED] });
    assert.deepEqual(decide([NESTED]), { owned: null, strays: [NESTED] });

    // A followed worktree is the selected space, so its main checkout goes wherever it sits, in either listing order.
    const main = `${PROJECTS}\\repoA`;
    const besideWorktree = `${PROJECTS}\\repoA-feature`;
    const insideWorktree = `${main}\\.worktrees\\feature`;
    assert.deepEqual(decide([main, besideWorktree], [ANCHOR, besideWorktree]), { owned: besideWorktree, strays: [main] });
    assert.deepEqual(decide([main, insideWorktree], [ANCHOR, insideWorktree]), { owned: insideWorktree, strays: [main] });
    assert.deepEqual(decide([insideWorktree, main], [ANCHOR, insideWorktree]), { owned: insideWorktree, strays: [main] });

    // A followed folder inside a parent repository keeps the parent until a deeper root also contains the folder.
    const inner = `${PROJECTS}\\repoC\\sub`;
    const repoC = `${PROJECTS}\\repoC`;
    assert.deepEqual(decide([repoC], [ANCHOR, inner]), { owned: repoC, strays: [] });
    assert.deepEqual(decide([repoC, inner], [ANCHOR, inner]), { owned: inner, strays: [repoC] });
    assert.deepEqual(decide([repoC, `${inner}\\deeper`], [ANCHOR, inner]), { owned: repoC, strays: [`${inner}\\deeper`] });

    // The anchor is never a space, and a folder past index 1 is never the selected one: a second repository may not hide behind either.
    assert.deepEqual(decide([ANCHOR, PARENT]), { owned: PARENT, strays: [ANCHOR] });
    assert.deepEqual(decide([ANCHOR]), { owned: null, strays: [ANCHOR] });
    assert.deepEqual(decide(["C:\\Users\\me\\AppData"]), { owned: null, strays: ["C:\\Users\\me\\AppData"] });
    assert.deepEqual(decide([PARENT, OUTSIDE], [ANCHOR, PARENT, OUTSIDE]), { owned: PARENT, strays: [OUTSIDE] });
    assert.deepEqual(decide([OUTSIDE, PARENT]), { owned: PARENT, strays: [OUTSIDE] });
    // A sibling sharing the followed folder's name as a prefix is not owned by it.
    assert.deepEqual(decide([`${PARENT}2`]), { owned: null, strays: [`${PARENT}2`] });

    // With no followed folder nothing is selected, so every root goes.
    assert.deepEqual(decide([OUTSIDE, ANCHOR], [ANCHOR]), { owned: null, strays: [OUTSIDE, ANCHOR] });
    assert.deepEqual(decide([OUTSIDE], []), { owned: null, strays: [OUTSIDE] });

    // Linux roots differing only in case are different repositories.
    const posix = ["/home/me/anchor", "/home/me/parentdir"];
    assert.deepEqual(decide(["/home/me/parentdir"], posix, "linux"), { owned: "/home/me/parentdir", strays: [] });
    assert.deepEqual(decide(["/home/me/PARENTDIR"], posix, "linux"), { owned: null, strays: ["/home/me/PARENTDIR"] });
    assert.deepEqual(decide(["/home/me/PARENTDIR"], posix, "darwin"), { owned: "/home/me/PARENTDIR", strays: [] });

    // A stray with no history is always dropped.
    assert.deepEqual(guard([NESTED, OUTSIDE], [], [], 0), { toggle: [NESTED, OUTSIDE], hold: [] });

    // A root that outlived the false write would loop forever however slowly it is retried, so no time passing releases it, while other strays still go.
    const once = [{ root: NESTED, at: 0 }];
    const survivorHeld = { toggle: [OUTSIDE], hold: [{ root: NESTED, reason: "survived-false-write" }] };
    assert.deepEqual(guard([NESTED, OUTSIDE], once, [NESTED.toUpperCase()], 1), survivorHeld);
    assert.deepEqual(guard([NESTED, OUTSIDE], once, [NESTED], 3_600_000), survivorHeld);
    // The folder change clears the history, and the new space starts over.
    assert.deepEqual(guard([NESTED, OUTSIDE], [], [NESTED], 3_600_000), { toggle: [NESTED, OUTSIDE], hold: [] });
    // A survivor's own folder setting outranks a burst, as the window's end cannot release it.
    const burst = [0, 1000, 2000, 3000].map((at) => ({ root: NESTED, at }));
    assert.deepEqual(guard([NESTED], burst, [NESTED], 4000), { toggle: [], hold: [{ root: NESTED, reason: "survived-false-write" }] });

    // Three quick returns may be Git's staggered reopens or a hand reopen and are still dropped; the fourth marks a loop.
    assert.deepEqual(guard([NESTED], burst.slice(0, 3), [], 4000), { toggle: [NESTED], hold: [] });
    assert.deepEqual(guard([NESTED, OUTSIDE], burst, [], 4000), { toggle: [OUTSIDE], hold: [{ root: NESTED, reason: "burst" }] });
    assert.deepEqual(guard([NESTED], burst, [], 9999), { toggle: [], hold: [{ root: NESTED, reason: "burst" }] });
    // A later reopen is a new event: the oldest attempt leaving the window releases the hold with no folder change.
    assert.deepEqual(guard([NESTED], burst, [], 10_000), { toggle: [NESTED], hold: [] });
    // Linux roots differing only in case share no history.
    const posixBurst = [0, 1, 2, 3].map((at) => ({ root: "/home/me/nestedrepo", at }));
    assert.deepEqual(guard(["/home/me/NESTEDREPO"], posixBurst, ["/home/me/nestedrepo"], 4, "linux"), { toggle: ["/home/me/NESTEDREPO"], hold: [] });

    assert.equal(initOffer(FOLDERS, true), true);
    assert.equal(initOffer(FOLDERS, false), false);
    assert.equal(initOffer([ANCHOR], true), false);
    assert.equal(initOffer([], true), false);
  });
});
