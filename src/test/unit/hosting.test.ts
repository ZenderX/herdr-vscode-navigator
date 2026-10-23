import assert from "node:assert/strict";
import { analyzeHosting, mayFollowAutomatically, parseMsysTable, parsePsTable, withTimeout } from "../../hosting";

describe("mayFollowAutomatically", () => {
  it("allows automatic plans only in a hosting window or an undetectable one the user confirmed", () => {
    assert.equal(mayFollowAutomatically("yes", undefined), true);
    assert.equal(mayFollowAutomatically("unknown", true), true);
    assert.equal(mayFollowAutomatically("unknown", undefined), false);
    assert.equal(mayFollowAutomatically("unknown", false), false);
    assert.equal(mayFollowAutomatically("no", true), false);
  });
});

const proc = (pid: number, ppid: number, name: string) => ({ pid, ppid, name });

describe("analyzeHosting", () => {
  it("is yes only when herdr.exe descends from this window's terminal shell", () => {
    const table = [proc(1, 0, "Code.exe"), proc(10, 1, "bash.exe"), proc(11, 10, "wt.exe"), proc(12, 11, "HERDR.EXE"), proc(20, 1, "bash.exe")];
    assert.equal(analyzeHosting(table, [10]).state, "yes");
    assert.equal(analyzeHosting(table, [20]).state, "no");
    assert.equal(analyzeHosting(table, []).state, "no");
    assert.equal(analyzeHosting([proc(5, 6, "herdr.exe"), proc(6, 5, "x.exe")], [99]).state, "no");
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

  it("follows MSYS parent links past a dead Windows parent, and is unknown rather than no without them", () => {
    // The native herdr.exe pid, not the server's, is what the exit watcher probes.
    assert.deepEqual(analyzeHosting(gitBashTable, [35640], msys), { state: "yes", clientPids: [23016] });
    assert.equal(analyzeHosting([...gitBashTable, proc(900, 2500, "bash.exe")], [900], msys).state, "no");
    assert.equal(analyzeHosting(gitBashTable, [35640]).state, "unknown");
  });
});

describe("withTimeout", () => {
  it("resolves undefined for a process scan that never settles, and passes through values and rejections", async () => {
    assert.equal(await withTimeout(new Promise<number>(() => {}), 5), undefined);
    assert.equal(await withTimeout(Promise.resolve(7), 1_000), 7);
    await assert.rejects(withTimeout(Promise.reject(new Error("x")), 1_000), /x/);
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

  it("is yes for a herdr client below a terminal shell, even under a directory named server, but ignores the herdr server", () => {
    assert.equal(analyzeHosting(table, [3000]).state, "yes");
    assert.equal(analyzeHosting(table, [4000]).state, "yes");
    assert.equal(analyzeHosting(table.filter(({ pid }) => pid !== 4200), [4000]).state, "no");
  });
});
