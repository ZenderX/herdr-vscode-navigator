import assert from "node:assert/strict";
import { defaultSocketName, isDefaultSessionSocket } from "../../../restore/defaultSocket";
import { resolvePipeName } from "../../../herdr/pipe";

const WIN_SESSION = "C:\\Users\\me\\AppData\\Roaming\\herdr\\session.json";
const WIN_ENV = { APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
const POSIX_SESSION = "/home/me/.config/herdr/session.json";

describe("isDefaultSessionSocket", () => {
  it("records for the default socket on win32", () => {
    const socket = resolvePipeName(undefined, WIN_ENV, "win32");
    assert.equal(isDefaultSessionSocket(WIN_SESSION, socket, "win32"), true);
    assert.equal(socket, defaultSocketName(WIN_SESSION, "win32"));
  });

  it("records for the default socket on linux", () => {
    const socket = resolvePipeName(undefined, { HOME: "/home/me" }, "linux");
    assert.equal(isDefaultSessionSocket(POSIX_SESSION, socket, "linux"), true);
  });

  it("does not record when socketPath points at another session's socket", () => {
    const socket = resolvePipeName("C:\\Users\\me\\AppData\\Roaming\\herdr\\sessions\\work\\herdr.sock", WIN_ENV, "win32");
    assert.equal(isDefaultSessionSocket(WIN_SESSION, socket, "win32"), false);
  });

  it("does not record when HERDR_SOCKET_PATH points at another socket", () => {
    const socket = resolvePipeName(undefined, { HOME: "/home/me", HERDR_SOCKET_PATH: "/home/me/.config/herdr/sessions/work/herdr.sock" }, "linux");
    assert.equal(isDefaultSessionSocket(POSIX_SESSION, socket, "linux"), false);
  });

  it("records when an explicit override equals the default", () => {
    const win = resolvePipeName("C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock", WIN_ENV, "win32");
    assert.equal(isDefaultSessionSocket(WIN_SESSION, win, "win32"), true);
    const posix = resolvePipeName(undefined, { HOME: "/elsewhere", HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock" }, "linux");
    assert.equal(isDefaultSessionSocket(POSIX_SESSION, posix, "linux"), true);
  });

  it("does not record when XDG_CONFIG_HOME moves session.json away from the default ~/.config socket", () => {
    const socket = resolvePipeName(undefined, { HOME: "/home/me" }, "linux");
    assert.equal(isDefaultSessionSocket("/xdg/herdr/session.json", socket, "linux"), false);
  });
});
