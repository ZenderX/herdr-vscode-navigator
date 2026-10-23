import assert from "node:assert/strict";
import { herdrVarsToRemove, planOpenRequest, withoutHerdrVars } from "../../../launch/planOpenRequest";

const ok = (spaceId: string, session?: string) => ({ ok: true as const, spaceId, ...(session === undefined ? {} : { session }) });
const live = (name: string) => ({ name, live: true });
const dead = (name: string) => ({ name, live: false });

describe("planOpenRequest", () => {
  it("reveals a live herdr terminal for the default session, otherwise creates one with an argv array and no --session", () => {
    assert.deepEqual(planOpenRequest({ request: ok("w3"), terminals: [dead("herdr"), live("herdr")], herdrPath: "/bin/herdr" }), {
      action: "reveal",
      terminalIndex: 1,
      focusArgs: ["workspace", "focus", "w3"],
    });
    assert.deepEqual(planOpenRequest({ request: ok("w3"), terminals: [dead("herdr")], herdrPath: "/bin/herdr" }), {
      action: "create",
      name: "herdr",
      shellPath: "/bin/herdr",
      shellArgs: [],
      focusArgs: ["workspace", "focus", "w3"],
    });
    assert.deepEqual(planOpenRequest({ request: ok("w1"), terminals: [], herdrPath: undefined }), { action: "herdr-missing" });
  });

  it("passes --session to the terminal and the focus call, never reusing the default session's terminal", () => {
    assert.deepEqual(planOpenRequest({ request: ok("w2", "work"), terminals: [live("herdr")], herdrPath: "/bin/herdr" }), {
      action: "create",
      name: "herdr (work)",
      shellPath: "/bin/herdr",
      shellArgs: ["--session", "work"],
      focusArgs: ["--session", "work", "workspace", "focus", "w2"],
    });
    const reveal = planOpenRequest({ request: ok("w2", "work"), terminals: [live("herdr"), live("herdr (work)")], herdrPath: undefined });
    assert.equal(reveal.action === "reveal" && reveal.terminalIndex, 1);
  });
});

describe("HERDR_* environment stripping", () => {
  it("removes every HERDR_ variable, case-insensitively, from the terminal and child environments and keeps the rest", () => {
    const env = { HERDR_ENV: "1", herdr_session: "x", PATH: "/bin", HOME: "/h" };
    assert.deepEqual(herdrVarsToRemove(env), { HERDR_ENV: null, herdr_session: null });
    assert.deepEqual(withoutHerdrVars(env), { PATH: "/bin", HOME: "/h" });
  });
});
