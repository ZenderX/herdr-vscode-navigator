import assert from "node:assert/strict";
import {
  analyzeHosting,
  classifyHosting,
  createCachedScan,
  mayFollowAutomatically,
  parseMsysTable,
  parseProcessTable,
  parsePsTable,
  withTimeout,
} from "../../hosting";

describe("mayFollowAutomatically", () => {
  it("blocks every automatic plan while detection is unknown and the window is undecided", () => {
    assert.equal(mayFollowAutomatically("unknown", undefined), false);
  });
  it("allows an unknown window the user confirmed", () => {
    assert.equal(mayFollowAutomatically("unknown", true), true);
  });
  it("blocks an unknown window the user declined", () => {
    assert.equal(mayFollowAutomatically("unknown", false), false);
  });
  it("allows a hosting window", () => {
    assert.equal(mayFollowAutomatically("yes", undefined), true);
  });
  it("blocks a non-hosting window even if a stale confirmation exists", () => {
    assert.equal(mayFollowAutomatically("no", true), false);
  });
});

describe("createCachedScan", () => {
  const ttl = (hosting: boolean): number => (hosting ? 30_000 : 5_000);

  it("reuses the cached result within the lifetime and rescans after it", async () => {
    let clock = 0;
    let scans = 0;
    const cache = createCachedScan(async () => (scans++, false), ttl, () => clock);
    await cache.get();
    clock = 4_999;
    await cache.get();
    assert.equal(scans, 1);
    clock = 5_000;
    await cache.get();
    assert.equal(scans, 2);
  });

  it("keeps a hosting result for 30 s", async () => {
    let clock = 0;
    let scans = 0;
    const cache = createCachedScan(async () => (scans++, true), ttl, () => clock);
    await cache.get();
    clock = 29_999;
    await cache.get();
    assert.equal(scans, 1);
    clock = 30_000;
    await cache.get();
    assert.equal(scans, 2);
  });

  it("shares one scan between concurrent requests, even forced ones", async () => {
    let scans = 0;
    const cache = createCachedScan(async () => (scans++, true), ttl, () => 0);
    const results = await Promise.all([cache.get(), cache.get(true), cache.get()]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(scans, 1);
  });

  it("force bypasses a fresh cache", async () => {
    let scans = 0;
    const cache = createCachedScan(async () => (scans++, false), ttl, () => 0);
    await cache.get();
    await cache.get(true);
    assert.equal(scans, 2);
  });
});

const proc = (pid: number, ppid: number, name: string) => ({ pid, ppid, name });

describe("classifyHosting", () => {
  it("is yes when herdr.exe descends from a terminal shell", () => {
    const table = [proc(1, 0, "Code.exe"), proc(10, 1, "bash.exe"), proc(11, 10, "wt.exe"), proc(12, 11, "HERDR.EXE")];
    assert.equal(classifyHosting(table, [10]), "yes");
  });

  it("is no for a herdr.exe that lives under another window's shell", () => {
    const table = [proc(1, 0, "Code.exe"), proc(10, 1, "bash.exe"), proc(20, 1, "bash.exe"), proc(21, 20, "herdr.exe")];
    assert.equal(classifyHosting(table, [10]), "no");
  });

  it("is no when no terminal has a process id or no herdr runs", () => {
    assert.equal(classifyHosting([proc(12, 10, "herdr.exe")], []), "no");
    assert.equal(classifyHosting([proc(10, 1, "bash.exe")], [10]), "no");
  });

  it("terminates on parent loops", () => {
    const table = [proc(5, 6, "herdr.exe"), proc(6, 5, "x.exe")];
    assert.equal(classifyHosting(table, [99]), "no");
  });

  // Git Bash forks a child that execs env.exe and exits, leaving herdr's Windows parent chain dead.
  const gitBashTable = [
    proc(2500, 1, "Code.exe"),
    proc(35640, 2500, "bash.exe"),
    proc(37312, 35640, "bash.exe"),
    proc(43520, 36176, "env.exe"),
    { ...proc(31364, 40176, "herdr.exe"), commandLine: "herdr.exe server" },
    { ...proc(23016, 43520, "herdr.exe"), commandLine: "herdr" },
  ];
  const msys = parseMsysTable(
    [
      "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
      "    18034       1   18034      37312 cons0       197609   Oct 15 /usr/bin/bash",
      "    18163   18034   18163      23016 cons0       197609 12:29:25 /c/Users/me/.herdr/bin/herdr",
    ].join("\n"),
  );

  it("follows MSYS parent links past a dead Windows parent", () => {
    assert.equal(classifyHosting(gitBashTable, [35640], msys), "yes");
    // The native herdr.exe pid, not the server's, is what the exit watcher probes.
    assert.deepEqual(analyzeHosting(gitBashTable, [35640], msys), { state: "yes", clientPids: [23016] });
  });

  it("still rejects another window's shell when the MSYS link is known", () => {
    const table = [...gitBashTable, proc(900, 2500, "bash.exe")];
    assert.equal(classifyHosting(table, [900], msys), "no");
  });

  it("is unknown, not no, when an MSYS-launched herdr chain dies at a missing pid", () => {
    assert.equal(classifyHosting(gitBashTable, [35640]), "unknown");
  });
});

describe("parseMsysTable", () => {
  it("maps MSYS parents to Windows pids positionally despite spaces in STIME and COMMAND", () => {
    const text = [
      "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
      "    18034       1   18034      37312 cons0       197609   Oct 15 /usr/bin/bash",
      "    18163   18034   18163      23016 cons0       197609   Oct 15 /c/Program Files/x y/herdr",
    ].join("\r\n");
    assert.deepEqual(parseMsysTable(text), [{ child: 23016, parent: 37312 }]);
  });
});

describe("withTimeout", () => {
  it("resolves undefined for a promise that never settles", async () => {
    assert.equal(await withTimeout(new Promise<number>(() => {}), 5), undefined);
  });

  it("passes through values and rejections", async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 1_000), 7);
    await assert.rejects(withTimeout(Promise.reject(new Error("x")), 1_000), /x/);
  });
});

describe("createCachedScan failure", () => {
  it("clears the in-flight scan when it rejects so the next get starts a new one", async () => {
    let scans = 0;
    const cache = createCachedScan(
      async () => {
        scans++;
        if (scans === 1) throw new Error("boom");
        return "yes";
      },
      () => 5_000,
      () => 0,
    );
    await assert.rejects(cache.get(), /boom/);
    assert.equal(await cache.get(), "yes");
    assert.equal(scans, 2);
  });
});

describe("parsePsTable and Linux-shaped hosting", () => {
  const text = [
    "    1     0 /sbin/init",
    " 2000     1 /usr/share/code/code --type=extensionHost",
    " 3000  2000 /bin/bash --login",
    " 3100  3000 /home/u/server/bin/herdr",
    " 4000     1 /bin/zsh",
    " 4100  4000 /usr/local/bin/herdr server",
    " 4200  4000 herdr",
  ].join("\n");
  const table = parsePsTable(text);

  it("parses pid and ppid positionally with the executable basename and its arguments", () => {
    assert.deepEqual(table[2], { pid: 3000, ppid: 2000, name: "bash", commandLine: "--login" });
    assert.deepEqual(table[3], { pid: 3100, ppid: 3000, name: "herdr" });
    assert.equal(table.length, 7);
  });

  it("is yes when a herdr client descends from a terminal shell, even under a directory named server", () => {
    assert.equal(classifyHosting(table, [3000]), "yes");
  });

  it("ignores the herdr server and is no for a shell without a client below it", () => {
    assert.equal(classifyHosting(table.filter(({ pid }) => pid !== 4200), [4000]), "no");
    assert.equal(classifyHosting(table, [4000]), "yes");
  });
});

describe("parseProcessTable", () => {
  it("parses an array and a lone object", () => {
    const row = { ProcessId: 4, ParentProcessId: 1, Name: "a.exe" };
    assert.deepEqual(parseProcessTable(JSON.stringify([row])), [proc(4, 1, "a.exe")]);
    assert.deepEqual(parseProcessTable(JSON.stringify(row)), [proc(4, 1, "a.exe")]);
  });

  it("drops malformed rows", () => {
    assert.deepEqual(parseProcessTable(JSON.stringify([{ ProcessId: 4 }, null])), []);
  });
});
