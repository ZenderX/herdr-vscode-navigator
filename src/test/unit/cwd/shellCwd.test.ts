import * as assert from "node:assert/strict";
import { findGitBash } from "../../../cwd/gitBash";
import { createMsysBatchProbe, createShellCwdProbe } from "../../../cwd/shellCwd";
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

  it("win32: reads the MSYS cwd of shell_pid through Git Bash as a Windows path, and spawns nothing when Git Bash is missing", async () => {
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

    const unspawned: Call[] = [];
    const noBash = createShellCwdProbe(makeDeps({ calls: unspawned, exists: () => false }));
    assert.deepEqual(await noBash(500, ""), { ok: false, reason: "Git Bash not found" });
    await assert.rejects(createMsysBatchProbe(makeDeps({ calls: unspawned, exists: () => false }))([], ""), /Git Bash not found/);
    assert.equal(unspawned.length, 0);
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

});

describe("createMsysBatchProbe", () => {
  it("keys one scan's folders by pane, refusing ambiguous launchers, and coalesces concurrent calls", async () => {
    const scans: Call[] = [];
    const lookups: Call[] = [];
    // MSYS bash winpids 7001..7003 and 900; launcher 500 has one MSYS child, 600 two, 650 only a native child.
    const scan = "7001\n7002\n7003\n900\nC:\\work\\a\nC:\\work\\b\nC:\\work\\c\nC:\\direct\n";
    const pairs = "500 7001\r\n600 7002\r\n600 7003\r\n650 8000\r\n";
    const batch = createMsysBatchProbe(
      makeDeps({
        execFile: (file, args) => {
          (file === BASH ? scans : lookups).push({ file, args });
          if (file === BASH) return Promise.resolve({ stdout: scan });
          const asked = new Set(args.slice(4));
          const stdout = pairs.split("\r\n").filter((line) => asked.has(line.split(" ")[0])).join("\r\n");
          return new Promise((resolve) => setTimeout(() => resolve({ stdout }), 5));
        },
      }),
    );
    const panes = [
      { paneId: "w:launcher", shellPid: 500 },
      { paneId: "w:ambiguous", shellPid: 600 },
      { paneId: "w:direct", shellPid: 900 },
      { paneId: "w:native", shellPid: 650 },
    ];
    const expected = new Map([
      ["w:launcher", { cwd: "C:\\work\\a", source: "msys" }],
      ["w:ambiguous", undefined],
      ["w:direct", { cwd: "C:\\direct", source: "msys" }],
      ["w:native", undefined],
    ]);

    const [first, second] = await Promise.all([batch(panes, ""), batch(panes, "")]);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.equal(scans.length, 1);
    assert.equal(lookups.length, 1);
    // The direct MSYS shell_pid resolves by winpid, so CIM is asked only about launchers.
    assert.deepEqual(lookups[0].args.slice(4), ["500", "600", "650"]);

    assert.deepEqual(await batch(panes, ""), expected);
    assert.equal(scans.length, 2);
    // 500 is memoized; the unresolved launchers are asked again because their shell may still be starting.
    assert.deepEqual(lookups[1].args.slice(4), ["600", "650"]);
  });
});
