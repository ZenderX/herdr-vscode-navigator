import * as assert from "node:assert/strict";
import { findGitBash } from "../../../cwd/gitBash";
import { createShellCwdProbe } from "../../../cwd/shellCwd";
import type { ProbeDeps } from "../../../cwd/types";

const BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";

interface Call {
  file: string;
  args: readonly string[];
}

function makeDeps(overrides: Partial<ProbeDeps> & { calls?: Call[] } = {}): ProbeDeps {
  const { calls, ...rest } = overrides;
  return {
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    readlink: () => Promise.reject(new Error("readlink not expected")),
    execFile: (file, args) => {
      calls?.push({ file, args });
      return Promise.reject(new Error("execFile not expected"));
    },
    exists: (path) => path === BASH,
    isDirectory: () => Promise.resolve(true),
    ...rest,
  };
}

const exitError = (code: number): Error => Object.assign(new Error(`exit ${code}`), { code });

describe("findGitBash", () => {
  const exists = (...present: string[]) => (path: string) => present.includes(path);

  it("prefers the configured path, then git.exe on PATH, then the well-known install directories", () => {
    const pathBash = "D:\\Tools\\Git\\usr\\bin\\bash.exe";
    const env = { PATH: "C:\\x;D:\\Tools\\Git\\cmd", ProgramFiles: "C:\\Program Files" };
    assert.equal(findGitBash("D:\\G\\usr\\bin\\bash.exe", { env, exists: exists("D:\\G\\usr\\bin\\bash.exe", pathBash, BASH) }), "D:\\G\\usr\\bin\\bash.exe");
    assert.equal(findGitBash("", { env, exists: exists("D:\\Tools\\Git\\cmd\\git.exe", pathBash, BASH) }), pathBash);
    assert.equal(findGitBash("", { env, exists: exists(BASH) }), BASH);
    assert.equal(findGitBash("", { env, exists: exists() }), undefined);
  });
});

describe("createShellCwdProbe", () => {
  it("linux: reads /proc/<pid>/cwd without spawning, and rejects a deleted directory", async () => {
    const reads: string[] = [];
    const probe = createShellCwdProbe(makeDeps({ platform: "linux", readlink: (path) => (reads.push(path), Promise.resolve("/home/me/work")) }));
    assert.deepEqual(await probe(77, ""), { ok: true, path: "/home/me/work" });
    assert.deepEqual(reads, ["/proc/77/cwd"]);

    const deleted = createShellCwdProbe(
      makeDeps({ platform: "linux", readlink: () => Promise.resolve("/gone (deleted)"), isDirectory: () => Promise.resolve(false) }),
    );
    assert.equal((await deleted(77, "")).ok, false);
  });

  it("darwin: runs lsof for the cwd descriptor and parses the n line", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        platform: "darwin",
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.resolve({ stdout: "p9\nfcwd\nn/Users/me/my proj\n" });
        },
      }),
    );
    assert.deepEqual(await probe(9, ""), { ok: true, path: "/Users/me/my proj" });
    assert.deepEqual(calls[0], { file: "lsof", args: ["-a", "-p", "9", "-d", "cwd", "-Fn"] });
  });

  it("win32: reads the MSYS cwd of shell_pid through Git Bash, passing the pid as an argument and returning a Windows path", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.resolve({ stdout: "/c/Users/me/proj\n" });
        },
      }),
    );
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\Users\\me\\proj" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, BASH);
    assert.deepEqual(calls[0].args.slice(2), ["_", "500"]);
  });

  it("win32: falls back to the Windows children of a native launcher, and reports 'not an MSYS process' when none is MSYS", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: "7692\r\n8000\r\n" });
          // First bash run (launcher pid) has no /proc entry; second run (descendants) matches.
          return args.includes("500") ? Promise.reject(exitError(1)) : Promise.resolve({ stdout: "C:\\live\\dir\n" });
        },
      }),
    );
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\live\\dir" });
    assert.deepEqual(calls[2].args.slice(2), ["_", "7692", "8000"]);

    const native = createShellCwdProbe(
      makeDeps({ execFile: (file) => (file === "powershell.exe" ? Promise.resolve({ stdout: "" }) : Promise.reject(exitError(1))) }),
    );
    assert.deepEqual(await native(500, ""), { ok: false, reason: "not an MSYS process" });
  });

  it("win32: reports 'Git Bash not found' without spawning anything", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(makeDeps({ calls, exists: () => false }));
    assert.deepEqual(await probe(500, ""), { ok: false, reason: "Git Bash not found" });
    assert.equal(calls.length, 0);
  });
});
