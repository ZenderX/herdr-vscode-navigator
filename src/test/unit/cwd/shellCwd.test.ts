import * as assert from "node:assert/strict";
import { findGitBash } from "../../../cwd/gitBash";
import { MSYS_CWD_SCRIPT, createShellCwdProbe, parseLsofCwd } from "../../../cwd/shellCwd";
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

  it("prefers the configured path over every auto-detected location", () => {
    const deps = { env: { ProgramFiles: "C:\\Program Files" }, exists: exists("D:\\G\\usr\\bin\\bash.exe", BASH) };
    assert.equal(findGitBash("D:\\G\\usr\\bin\\bash.exe", deps), "D:\\G\\usr\\bin\\bash.exe");
  });

  it("maps git.exe on PATH (cmd layout) to usr\\bin\\bash.exe before well-known dirs", () => {
    const pathBash = "D:\\Tools\\Git\\usr\\bin\\bash.exe";
    const deps = { env: { PATH: "C:\\x;D:\\Tools\\Git\\cmd", ProgramFiles: "C:\\Program Files" }, exists: exists("D:\\Tools\\Git\\cmd\\git.exe", pathBash, BASH) };
    assert.equal(findGitBash("", deps), pathBash);
  });

  it("maps git.exe in mingw64\\bin two levels up", () => {
    const pathBash = "D:\\Tools\\Git\\usr\\bin\\bash.exe";
    const deps = { env: { PATH: "D:\\Tools\\Git\\mingw64\\bin" }, exists: exists("D:\\Tools\\Git\\mingw64\\bin\\git.exe", pathBash) };
    assert.equal(findGitBash("", deps), pathBash);
  });

  it("falls back to Program Files, then Program Files (x86), then LocalAppData", () => {
    const x86 = "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe";
    const local = "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe";
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LocalAppData: "C:\\Users\\u\\AppData\\Local" };
    assert.equal(findGitBash("", { env, exists: exists(BASH, x86, local) }), BASH);
    assert.equal(findGitBash("", { env, exists: exists(x86, local) }), x86);
    assert.equal(findGitBash("", { env, exists: exists(local) }), local);
    assert.equal(findGitBash("", { env, exists: exists() }), undefined);
  });
});

describe("parseLsofCwd", () => {
  it("takes the n line from -Fn output", () => {
    assert.equal(parseLsofCwd("p123\nfcwd\nn/Users/me/my project\n"), "/Users/me/my project");
    assert.equal(parseLsofCwd("p123\nfcwd\n"), null);
  });
});

describe("createShellCwdProbe", () => {
  it("linux: reads /proc/<pid>/cwd without spawning", async () => {
    const reads: string[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        platform: "linux",
        readlink: (path) => {
          reads.push(path);
          return Promise.resolve("/home/me/work");
        },
      }),
    );
    assert.deepEqual(await probe(77, ""), { ok: true, path: "/home/me/work" });
    assert.deepEqual(reads, ["/proc/77/cwd"]);
  });

  it("linux: rejects a deleted or missing directory as a failure", async () => {
    const probe = createShellCwdProbe(
      makeDeps({ platform: "linux", readlink: () => Promise.resolve("/gone (deleted)"), isDirectory: () => Promise.resolve(false) }),
    );
    const result = await probe(77, "");
    assert.equal(result.ok, false);
  });

  it("darwin: runs lsof for the cwd descriptor and parses the n line", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        platform: "darwin",
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.resolve({ stdout: "p9\nfcwd\nn/Users/me/proj\n" });
        },
      }),
    );
    assert.deepEqual(await probe(9, ""), { ok: true, path: "/Users/me/proj" });
    assert.deepEqual(calls[0], { file: "lsof", args: ["-a", "-p", "9", "-d", "cwd", "-Fn"] });
  });

  it("win32: reads the MSYS cwd of shell_pid directly, passing the pid as an argument", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.resolve({ stdout: "C:\\Users\\me\\proj\r\n" });
        },
      }),
    );
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\Users\\me\\proj" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, BASH);
    assert.deepEqual(calls[0].args.slice(2), ["_", "500"]);
  });

  it("win32: converts an MSYS-form result to a Windows path", async () => {
    const probe = createShellCwdProbe(makeDeps({ execFile: () => Promise.resolve({ stdout: "/c/Users/me/proj\n" }) }));
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\Users\\me\\proj" });
  });

  it("win32: falls back to the shell's Windows descendants when shell_pid is a native launcher", async () => {
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
    assert.deepEqual(calls[1].args.at(-1), "500");
    assert.deepEqual(calls[2].args.slice(2), ["_", "7692", "8000"]);
  });

  it("win32 and darwin: invoke powershell and lsof by absolute system path", async () => {
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const winCalls: Call[] = [];
    const win = createShellCwdProbe(
      makeDeps({
        calls: winCalls,
        exists: (path) => path === BASH || path === ps,
        execFile: (file, args) => {
          winCalls.push({ file, args });
          if (file === ps) return Promise.resolve({ stdout: "7692\r\n" });
          return args.includes("500") ? Promise.reject(exitError(1)) : Promise.resolve({ stdout: "C:\\live\\dir\n" });
        },
      }),
    );
    assert.equal((await win(500, "")).ok, true);
    assert.ok(winCalls.some(({ file }) => file === ps));

    const macCalls: Call[] = [];
    const mac = createShellCwdProbe(
      makeDeps({
        platform: "darwin",
        exists: (path) => path === "/usr/sbin/lsof",
        execFile: (file, args) => {
          macCalls.push({ file, args });
          return Promise.resolve({ stdout: "p9\nfcwd\nn/Users/me/proj\n" });
        },
      }),
    );
    await mac(9, "");
    assert.equal(macCalls[0].file, "/usr/sbin/lsof");
  });

  it("win32: a native shell with no MSYS descendants reports 'not an MSYS process'", async () => {
    const probe = createShellCwdProbe(
      makeDeps({
        execFile: (file) => (file === "powershell.exe" ? Promise.resolve({ stdout: "" }) : Promise.reject(exitError(1))),
      }),
    );
    assert.deepEqual(await probe(500, ""), { ok: false, reason: "not an MSYS process" });
  });

  it("win32: a native shell does not adopt an MSYS grandchild", async () => {
    const calls: Call[] = [];
    // Process table: 500 (native shell) -> 7692 (native child) -> 9000 (MSYS bash tool); only 9000 has an MSYS /proc entry.
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: "7692\r\n" });
          return args.slice(2).includes("9000") ? Promise.resolve({ stdout: "C:\\other\n" }) : Promise.reject(exitError(1));
        },
      }),
    );
    assert.deepEqual(await probe(500, ""), { ok: false, reason: "not an MSYS process" });
    const script = calls.find(({ file }) => file === "powershell.exe")?.args.at(-2) ?? "";
    assert.ok(/ParentProcessId=\$root/.test(script) && !/while|queue/.test(script), "child lookup must not recurse");
  });

  it("win32: memoises the launcher-to-shell mapping so a repeat probe runs only bash", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: "7692\r\n" });
          return args.includes("500") ? Promise.reject(exitError(1)) : Promise.resolve({ stdout: "C:\\live\\dir\n" });
        },
      }),
    );
    await probe(500, "");
    calls.length = 0;
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\live\\dir" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, BASH);
    assert.deepEqual(calls[0].args.slice(2), ["_", "7692"]);
  });

  it("win32: drops a memoised mapping whose probe fails and rediscovers", async () => {
    let stale = false;
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: stale ? "9000\r\n" : "7692\r\n" });
          if (args.includes("500") || (stale && args.includes("7692"))) return Promise.reject(exitError(1));
          return Promise.resolve({ stdout: "C:\\live\\dir\n" });
        },
      }),
    );
    await probe(500, "");
    stale = true;
    calls.length = 0;
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\live\\dir" });
    assert.ok(calls.some(({ file }) => file === "powershell.exe"), "must rediscover through PowerShell");
    assert.deepEqual(calls.at(-1)?.args.slice(2), ["_", "9000"]);
  });

  it("win32: memoises 'not an MSYS process' so native panes skip probing", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return file === "powershell.exe" ? Promise.resolve({ stdout: "" }) : Promise.reject(exitError(1));
        },
      }),
    );
    await probe(500, "");
    calls.length = 0;
    assert.deepEqual(await probe(500, ""), { ok: false, reason: "not an MSYS process" });
    assert.equal(calls.length, 0);
  });

  it("win32: the MSYS script does not depend on the caller's PATH for its tools", () => {
    assert.match(MSYS_CWD_SCRIPT, /^PATH=\/usr\/bin:\$PATH;/);
    assert.doesNotMatch(MSYS_CWD_SCRIPT, /\$\(cat /);
  });

  it("win32: a tool failure (exit 2) is a probe failure and is not memoised as native", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.reject(exitError(2));
        },
      }),
    );
    const first = await probe(500, "");
    assert.equal(first.ok, false);
    assert.notEqual(first.ok === false && first.reason, "not an MSYS process");
    calls.length = 0;
    await probe(500, "");
    assert.equal(calls.length, 1, "pid must be probed again");
  });

  it("win32: reports 'Git Bash not found' without spawning anything", async () => {
    const calls: Call[] = [];
    const probe = createShellCwdProbe(makeDeps({ calls, exists: () => false }));
    assert.deepEqual(await probe(500, ""), { ok: false, reason: "Git Bash not found" });
    assert.equal(calls.length, 0);
  });

  it("win32: a timeout is a failure reason, not a throw", async () => {
    const probe = createShellCwdProbe(makeDeps({ execFile: () => Promise.reject(Object.assign(new Error("timed out"), { killed: true })) }));
    const result = await probe(500, "");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /timed out/);
  });

  it("win32: caches the discovered Git Bash path for the session", async () => {
    let lookups = 0;
    const probe = createShellCwdProbe(
      makeDeps({
        exists: (path) => {
          lookups += 1;
          return path === BASH;
        },
        execFile: () => Promise.resolve({ stdout: "C:\\a\n" }),
      }),
    );
    await probe(1, "");
    const afterFirst = lookups;
    await probe(2, "");
    assert.equal(lookups, afterFirst);
  });

  it("win32: a changed gitBashPath setting replaces the cached bash path", async () => {
    const custom = "D:\\custom\\usr\\bin\\bash.exe";
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        exists: () => true,
        execFile: (file, args) => {
          calls.push({ file, args });
          return Promise.resolve({ stdout: "C:\\a\n" });
        },
      }),
    );
    await probe(100, "");
    await probe(100, custom);
    await probe(200, custom);
    assert.deepEqual(calls.map(({ file }) => file), [BASH, custom, custom]);
  });

  it("win32: a timeout of the memoised run is returned without rediscovery", async () => {
    let hang = false;
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: "7692\r\n" });
          if (hang) return Promise.reject(Object.assign(new Error("timed out"), { killed: true }));
          return args.includes("500") ? Promise.reject(exitError(1)) : Promise.resolve({ stdout: "C:\\live\n" });
        },
      }),
    );
    await probe(500, "");
    hang = true;
    calls.length = 0;
    const result = await probe(500, "");
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(2), ["_", "7692"]);
  });

  it("win32: 'not an MSYS process' expires so a reused or late-started pid is probed again", async () => {
    let clock = 0;
    let native = true;
    const calls: Call[] = [];
    const probe = createShellCwdProbe(
      makeDeps({
        calls,
        now: () => clock,
        execFile: (file, args) => {
          calls.push({ file, args });
          if (file === "powershell.exe") return Promise.resolve({ stdout: native ? "" : "7692\r\n" });
          return args.includes("500") ? Promise.reject(exitError(1)) : Promise.resolve({ stdout: "C:\\live\n" });
        },
      }),
    );
    assert.equal((await probe(500, "")).ok, false);
    native = false;
    clock = 29_000;
    assert.equal((await probe(500, "")).ok, false, "still memoised inside the TTL");
    clock = 31_000;
    assert.deepEqual(await probe(500, ""), { ok: true, path: "C:\\live" });
  });

  it("rejects an invalid pid and an unsupported platform", async () => {
    assert.equal((await createShellCwdProbe(makeDeps())(0, "")).ok, false);
    assert.equal((await createShellCwdProbe(makeDeps({ platform: "freebsd" }))(5, "")).ok, false);
  });
});
