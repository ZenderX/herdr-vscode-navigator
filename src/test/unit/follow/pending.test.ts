import assert from "node:assert/strict";
import { PENDING_STALE_MS, reconcilePending as reconcilePendingOn } from "../../../follow/pending";

// Tests default to win32 explicitly so they run identically on any host.
const reconcilePending = (
  pending: unknown,
  open: readonly { path: string }[],
  now: number,
  platform: NodeJS.Platform = "win32",
) => reconcilePendingOn(pending, open, now, platform);

const folders = (...paths: string[]) => paths.map((path) => ({ path }));
const NOW = 1_000_000;

describe("reconcilePending", () => {
  it("reconciles and clears an intent whose target is already open (case and slash differences ignored)", () => {
    const outcome = reconcilePending({ target: "C:\\Work\\", at: NOW - 1000 }, folders("C:\\anchor", "c:\\work"), NOW);
    assert.equal(outcome.action, "reconciled");
    assert.equal(outcome.clear, true);
  });

  it("reconciles a POSIX intent", () => {
    const outcome = reconcilePending({ target: "/home/u/x/", at: NOW }, folders("/home/u/anchor", "/home/u/x"), NOW, "linux");
    assert.deepEqual([outcome.action, outcome.clear], ["reconciled", true]);
    const other = reconcilePending({ target: "/home/u/X", at: NOW }, folders("/home/u/anchor", "/home/u/x"), NOW, "linux");
    assert.equal(other.action, "replan");
  });

  it("does not count the anchor at index 0 as a reconciled target", () => {
    const outcome = reconcilePending({ target: "C:\\anchor", at: NOW }, folders("C:\\anchor"), NOW);
    assert.equal(outcome.action, "replan");
    assert.equal(outcome.clear, false);
  });

  it("keeps a fresh intent whose target is not open so the next cycle re-plans it", () => {
    const outcome = reconcilePending({ target: "C:\\w", at: NOW - 1000 }, folders("C:\\anchor"), NOW);
    assert.deepEqual([outcome.action, outcome.clear], ["replan", false]);
  });

  it("clears a stale intent", () => {
    const outcome = reconcilePending({ target: "C:\\w", at: NOW - PENDING_STALE_MS - 1 }, folders("C:\\anchor"), NOW);
    assert.deepEqual([outcome.action, outcome.clear], ["discard", true]);
  });

  it("clears a malformed intent and ignores a missing one", () => {
    assert.deepEqual(reconcilePending({ target: 1 }, [], NOW).clear, true);
    assert.deepEqual(reconcilePending(undefined, [], NOW), { action: "none", clear: false, message: "no pending intent" });
  });
});
