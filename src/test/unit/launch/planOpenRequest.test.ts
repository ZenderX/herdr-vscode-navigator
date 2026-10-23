import assert from "node:assert/strict";
import { herdrVarsToRemove, planOpenRequest, withoutHerdrVars } from "../../../launch/planOpenRequest";

const ok = (spaceId: string, session?: string) => ({ ok: true as const, spaceId, ...(session === undefined ? {} : { session }) });
const live = (name: string) => ({ name, live: true });
const dead = (name: string) => ({ name, live: false });

describe("planOpenRequest", () => {
  it("reveals the existing live terminal for the default session", () => {
    const plan = planOpenRequest({ request: ok("w3"), terminals: [dead("bash"), live("herdr")], herdrPath: "/bin/herdr" });
    assert.deepEqual(plan, { action: "reveal", terminalIndex: 1, focusArgs: ["workspace", "focus", "w3"] });
  });

  it("creates a terminal instead of revealing a herdr-named shell with no live client", () => {
    const plan = planOpenRequest({ request: ok("w3"), terminals: [dead("herdr")], herdrPath: "/bin/herdr" });
    assert.equal(plan.action, "create");
  });

  it("skips a dead herdr terminal and reveals a later live one", () => {
    const plan = planOpenRequest({ request: ok("w3"), terminals: [dead("herdr"), live("herdr")], herdrPath: "/bin/herdr" });
    assert.equal(plan.action === "reveal" && plan.terminalIndex, 1);
  });

  it("creates a terminal with an argv array and no --session when none is given", () => {
    const plan = planOpenRequest({ request: ok("w3"), terminals: [dead("bash")], herdrPath: "/bin/herdr" });
    assert.deepEqual(plan, { action: "create", name: "herdr", shellPath: "/bin/herdr", shellArgs: [], focusArgs: ["workspace", "focus", "w3"] });
  });

  it("passes --session to the terminal and the focus call when given", () => {
    const plan = planOpenRequest({ request: ok("w2", "work"), terminals: [live("herdr")], herdrPath: "/bin/herdr" });
    assert.deepEqual(plan, {
      action: "create",
      name: "herdr (work)",
      shellPath: "/bin/herdr",
      shellArgs: ["--session", "work"],
      focusArgs: ["--session", "work", "workspace", "focus", "w2"],
    });
  });

  it("does not reveal the default terminal for a named session", () => {
    const plan = planOpenRequest({ request: ok("w2", "work"), terminals: [live("herdr"), live("herdr (work)")], herdrPath: undefined });
    assert.equal(plan.action, "reveal");
    assert.equal(plan.action === "reveal" && plan.terminalIndex, 1);
  });

  it("reports a missing herdr only when a terminal would be created", () => {
    assert.deepEqual(planOpenRequest({ request: ok("w1"), terminals: [], herdrPath: undefined }), { action: "herdr-missing" });
    assert.deepEqual(planOpenRequest({ request: ok("w1"), terminals: [dead("herdr")], herdrPath: undefined }), { action: "herdr-missing" });
  });

  it("rejects an invalid request without any terminal action", () => {
    const plan = planOpenRequest({ request: { ok: false, reason: "invalid space" }, terminals: [live("herdr")], herdrPath: "/bin/herdr" });
    assert.deepEqual(plan, { action: "reject", reason: "invalid space" });
  });

  it("keeps request values as single argv elements", () => {
    const plan = planOpenRequest({ request: ok("w1:t1"), terminals: [], herdrPath: "/bin/herdr" });
    assert.equal(plan.action === "create" && plan.focusArgs[2], "w1:t1");
  });
});

describe("HERDR_* environment stripping", () => {
  const env = { HERDR_ENV: "1", herdr_session: "x", PATH: "/bin", HOME: "/h" };

  it("marks every HERDR_ variable, case-insensitively, for removal from the terminal", () => {
    assert.deepEqual(herdrVarsToRemove(env), { HERDR_ENV: null, herdr_session: null });
  });

  it("drops them from a child process environment and keeps the rest", () => {
    assert.deepEqual(withoutHerdrVars(env), { PATH: "/bin", HOME: "/h" });
  });
});
