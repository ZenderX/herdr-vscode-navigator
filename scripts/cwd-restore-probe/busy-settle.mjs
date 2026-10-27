// Live check, on Windows, of the extension's return path (compiled out/restore) against restored Git Bash login panes
// after a server restart, in the scratch session `navigator-busy-probe`: how long each restored shell stays busy and
// whether every moved pane is returned to its live folder. See README.md. Every herdr call names `--session`, except the
// read-only `herdr session list --json` and `herdr session stop|delete navigator-busy-probe`.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'navigator-busy-probe';
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const MSYS_PS = 'C:/Program Files/Git/usr/bin/ps.exe';
// 5 spaces of 2 panes: the 10 login shells of the 2026-10-25 run 2; 4 of them cd'd, as its 3 return candidates.
const WORKSPACES = 5;
const MOVED = 4;
// returnService.ts READY_TIMEOUT_MS, not exported.
const READY_TIMEOUT_MS = 20000;
const MARGIN_MS = 5000;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-busy-'));
const spawnDir = path.join(scratch, 'spawn here');
const storeDir = path.join(scratch, 'store');
const configPath = path.join(scratch, 'config.toml');
const movedDirs = Array.from({ length: MOVED }, (_, i) => path.join(scratch, `live ${i + 1}`));
for (const dir of [spawnDir, storeDir, ...movedDirs]) mkdirSync(dir, { recursive: true });
// Your login shell setup as herdr runs it (shell_mode = "login"); only the config file is scratch.
writeFileSync(configPath, `onboarding = false\n\n[terminal]\ndefault_shell = "${GIT_BASH}"\nshell_mode = "login"\n`);

// HOME stays yours so the panes run your ~/.bash_profile and ~/.bashrc; ORIGINAL_PATH is dropped as your herdr() wrapper does.
const dropped = new Set(['PS1', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV', 'ORIGINAL_PATH']);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('HERDR_') && !dropped.has(key.toUpperCase()))),
  HERDR_CONFIG_PATH: configPath,
};

const started = Date.now();
const summary = { date: new Date(started).toISOString(), session: SESSION, readyTimeoutMs: READY_TIMEOUT_MS, panes: [] };

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
async function herdrOk(...args) {
  const result = await exec('herdr', ['--session', SESSION, ...args]);
  if (result.exit !== 0) throw new Error(`herdr --session ${SESSION} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return json(result.stdout)?.result;
}
async function waitFor(label, check, ms, stepMs = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}`);
}
const sessions = async () => json((await exec('herdr', ['session', 'list', '--json'])).stdout)?.sessions ?? [];
const sessionInfo = async (name = SESSION) => (await sessions()).find((session) => session.name === name);
const norm = (folder) => (folder ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const bashQuote = (p) => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

function startServer() {
  const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd: scratch, stdio: 'ignore', detached: true, env });
  server.unref();
  return waitFor(`server ${SESSION} running`, async () => (await sessionInfo())?.running, 30000, 100);
}

// The return path as the extension builds it, from out/ (npm run compile).
function loadExtension() {
  const require = createRequire(import.meta.url);
  const sources = ['restore', 'cwd', 'herdr'].flatMap((dir) => readdirSync(path.join(repoRoot, 'src', dir)).map((name) => path.join(dir, name)));
  for (const source of [...sources, 'hosting.ts', 'paths.ts', 'toolPaths.ts', 'log.ts']) {
    const built = path.join(repoRoot, 'out', source.replace(/\.ts$/, '.js'));
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(path.join(repoRoot, 'src', source)).mtimeMs) throw new Error(`out/ is older than src/${source}; run npm run compile first`);
  }
  const load = (name) => require(path.join(repoRoot, 'out', name));
  return {
    ...load('restore/returnService.js'),
    ...load('restore/paneBusy.js'),
    ...load('restore/record.js'),
    ...load('cwd/liveCwd.js'),
    ...load('cwd/nodeDeps.js'),
    ...load('herdr/index.js'),
    ...load('hosting.js'),
  };
}

// One `ps -W` per look, parsed by the extension's own parser; the command column names a busy shell's children.
async function msysTable(parseMsysTable) {
  const { exit, stdout, stderr } = await exec(MSYS_PS, ['-W']);
  if (exit !== 0) throw new Error(`ps -W failed: ${stderr}`);
  const commands = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const row = /^\s*[A-Za-z]?\s*\d+\s+\d+\s+\d+\s+(\d+)\s+\S+\s+\d+\s+(?:\d\d:\d\d:\d\d|[A-Z][a-z]{2}\s+\d+)\s+(.*)$/.exec(line);
    if (row) commands.set(Number(row[1]), row[2].trim());
  }
  return { edges: parseMsysTable(stdout), commands };
}

// Windows creation time (unix ms) of each pid.
async function creationTimes(pids) {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return new Map(stdout.split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(' ').map(Number)));
}

let failure;
try {
  if (process.platform !== 'win32') throw new Error('this check drives Git for Windows and runs on Windows only');
  if (await sessionInfo()) throw new Error(`session ${SESSION} already exists`);
  const defaultBefore = (await sessions()).find((session) => session.default);
  summary.defaultSessionBefore = defaultBefore && { name: defaultBefore.name, running: defaultBefore.running };
  const ext = loadExtension();
  const probeDeps = ext.nodeProbeDeps();

  await startServer();
  const info = await sessionInfo();
  summary.sessionDir = info.session_dir;
  const pipeName = ext.resolvePipeName(info.socket_path, {}, 'win32');
  const client = new ext.HerdrClient({ pipeName });
  const probe = ext.createLiveCwdProbe({ processInfo: (paneId) => client.processInfo(paneId) }, probeDeps);
  const liveFolders = async (ids) => {
    const shells = [];
    for (const paneId of ids) shells.push({ paneId, shellPid: (await client.processInfo(paneId)).shell_pid });
    const batch = await probe.probeShells(shells, { gitBashPath: '' });
    return new Map(ids.map((id) => [id, batch.get(id)?.cwd]));
  };

  const workspaces = [];
  const all = [];
  for (let i = 1; i <= WORKSPACES; i++) {
    const created = await herdrOk('workspace', 'create', '--cwd', spawnDir, '--label', `busy ${i}`, '--no-focus');
    const split = (await herdrOk('pane', 'split', created.root_pane.pane_id, '--direction', 'right', '--no-focus'))?.pane?.pane_id;
    if (!split) throw new Error(`pane split in busy ${i} returned no pane id`);
    workspaces.push(created.workspace.workspace_id);
    all.push(created.root_pane.pane_id, split);
  }
  const moved = Object.fromEntries(all.filter((_, i) => i % 2 === 0).slice(0, MOVED).map((id, i) => [id, movedDirs[i]]));
  await waitFor('every inner shell in the spawn folder', async () => [...(await liveFolders(all)).values()].every((cwd) => norm(cwd) === norm(spawnDir)), 60000, 1000);
  for (const [id, folder] of Object.entries(moved)) await herdrOk('pane', 'run', id, `cd ${bashQuote(folder)}`);
  await waitFor('every moved shell in its live folder', async () => {
    const live = await liveFolders(Object.keys(moved));
    return Object.entries(moved).every(([id, folder]) => norm(live.get(id)) === norm(folder));
  }, 30000, 1000);
  const cdAt = Date.now();

  // State the restart run reads, written by the extension's own recorder.
  let measuring = false;
  let looks = 0;
  const logs = [];
  const verdicts = [];
  const readyAt = new Map();
  const service = (label) => {
    const log = (level, msg) => logs.push({ at: Date.now(), service: label, level, msg });
    const busyBase = ext.nodePaneBusyDeps(log);
    return ext.createReturnService({
      platform: 'win32',
      log,
      clock: { now: () => Date.now(), sleep },
      pipeName: () => pipeName,
      client: (name) => new ext.HerdrClient({ pipeName: name, log }),
      store: ext.fileRecordStore(storeDir, log),
      isDirectory: (folder) => probeDeps.isDirectory(folder),
      connected: () => true,
      holdsLease: () => true,
      pluginState: () => 'absent',
      busyCheck: () => {
        const look = ++looks;
        let table;
        const children = new Map();
        const check = ext.createPaneBusyCheck({
          ...busyBase,
          readMsysEdges: async () => {
            table = await msysTable(ext.parseMsysTable);
            return table.edges;
          },
          win32Children: async (pid) => {
            const kids = await busyBase.win32Children(pid);
            children.set(pid, kids);
            return kids;
          },
        });
        return async (paneInfo) => {
          const busy = await check(paneInfo);
          const shells = new Set([paneInfo.shell_pid, ...(children.get(paneInfo.shell_pid) ?? [])]);
          const kids = (table?.edges ?? []).filter(({ parent }) => shells.has(parent)).map(({ child }) => table.commands.get(child) ?? String(child));
          if (measuring) verdicts.push({ pane: paneInfo.pane_id, look, at: Date.now(), busy, children: kids });
          return busy;
        };
      },
      probeShells: async (shells) => {
        const batch = await probe.probeShells(shells, { gitBashPath: '' });
        if (measuring) for (const [id, reading] of batch) if (reading && !readyAt.has(id)) readyAt.set(id, Date.now());
        return batch;
      },
    });
  };
  const store = ext.fileRecordStore(storeDir, () => undefined);
  const readRecord = () => store.read(ext.recordKey(pipeName));
  await service('before').reconcile();
  const recorded = await waitFor('the record of every pane with folder, spawn and shell pid', () => {
    const record = readRecord();
    const ok = all.every((id) => {
      const entry = record.panes[id];
      return entry?.shellPid !== undefined && entry.spawn !== undefined && norm(entry.folder) === norm(moved[id] ?? spawnDir);
    });
    return ok ? record : undefined;
  }, 20000, 500);
  summary.recordBeforeStop = recorded.panes;

  // herdr autosaves 10-12 s after a change; the restart restores what it saved.
  const sessionJson = path.join(summary.sessionDir, 'session.json');
  const savedIds = () => (existsSync(sessionJson) ? (json(readFileSync(sessionJson, 'utf8'))?.workspaces ?? []).map(({ id }) => id).sort() : []);
  await waitFor('autosave of the workspaces', () => JSON.stringify(savedIds()) === JSON.stringify([...workspaces].sort()), 30000, 500);
  summary.autosaveAfterCd = await waitFor('an autosave after the cd', () => existsSync(sessionJson) && statSync(sessionJson).mtimeMs > cdAt, 15000, 500).catch(() => false);

  await exec('herdr', ['session', 'stop', SESSION]);
  await waitFor('server stopped', async () => !(await sessionInfo())?.running, 15000);
  measuring = true;
  const restartAt = Date.now();
  await startServer();
  const runningAt = Date.now();
  // As in run 2: the socket comes back, the connection reports a reconnect and the return runs at once.
  await service('restart').onReconnected();
  const returnedAt = Date.now();
  measuring = false;
  summary.timingsMs = { serverUp: runningAt - restartAt, returnRun: returnedAt - runningAt };
  summary.returnLog = logs.filter(({ service: label, level }) => label === 'restart' && level !== 'debug').map(({ at, level, msg }) => `+${at - restartAt} ms ${level} ${msg}`);
  const summaryLine = logs.find(({ service: label, msg }) => label === 'restart' && msg.startsWith('cwd-return: ') && /panes returned/.test(msg))?.msg;
  summary.summaryLine = summaryLine;

  const pids = new Map();
  for (const id of all) pids.set(id, (await client.processInfo(id)).shell_pid);
  const created = await creationTimes([...pids.values()]);
  const finals = await waitFor('every moved pane in its live folder', async () => {
    const live = await liveFolders(all);
    return Object.entries(moved).every(([id, folder]) => norm(live.get(id)) === norm(folder)) ? live : undefined;
  }, 10000, 1000).catch(() => liveFolders(all));
  const after = readRecord();
  for (const id of all) {
    const spawnAt = created.get(pids.get(id));
    const mine = verdicts.filter(({ pane }) => pane === id);
    const firstIdle = mine.find(({ busy }) => !busy);
    const rel = (at) => (at === undefined || spawnAt === undefined ? undefined : at - spawnAt);
    summary.panes.push({
      pane: id,
      needsCd: id in moved,
      spawnAtMs: spawnAt === undefined ? undefined : spawnAt - restartAt,
      readyMs: rel(readyAt.get(id)),
      firstVerdictMs: rel(mine[0]?.at),
      firstIdleMs: rel(firstIdle?.at),
      busyLooks: mine.filter(({ busy }) => busy).length,
      childrenAtFirstCheck: mine[0]?.children,
      busyChildren: [...new Set(mine.filter(({ busy }) => busy).flatMap(({ children }) => children))],
      finalFolder: finals.get(id),
      recordAfter: after.panes[id],
      atLiveFolder: norm(finals.get(id)) === norm(moved[id] ?? spawnDir),
    });
  }
  const settles = summary.panes.filter(({ needsCd }) => needsCd).map(({ firstIdleMs }) => firstIdleMs);
  summary.busyReproduced = verdicts.some(({ busy }) => busy);
  summary.longestSettleMs = settles.some((ms) => ms === undefined) ? undefined : Math.max(...settles);
  summary.insideWindowWithMargin = summary.longestSettleMs !== undefined && summary.longestSettleMs <= READY_TIMEOUT_MS - MARGIN_MS;
  const notBack = summary.panes.filter(({ atLiveFolder }) => !atLiveFolder).map(({ pane }) => pane);
  if (notBack.length) throw new Error(`panes not at their live folder after the return: ${notBack.join(', ')}`);
  if (!summaryLine?.startsWith(`cwd-return: ${MOVED} panes returned`)) throw new Error(`unexpected return summary: ${summaryLine}`);
  for (const [id, folder] of Object.entries(moved)) {
    if (norm(after.panes[id]?.folder) !== norm(folder) || after.panes[id]?.shellPid !== pids.get(id)) throw new Error(`record after the return holds ${JSON.stringify(after.panes[id])} for ${id}`);
  }
} catch (error) {
  failure = error;
} finally {
  // Every step runs even when an earlier one throws, so the summary is always printed and what was left is named.
  const cleanup = { failures: [] };
  const step = async (name, run) => {
    try { await run(); } catch (error) { cleanup.failures.push(`${name}: ${error.message}`); }
  };
  await step('session stop', () => exec('herdr', ['session', 'stop', SESSION]));
  await sleep(1000);
  await step('session delete', () => exec('herdr', ['session', 'delete', SESSION]));
  await step('remove session dir', () => { const dir = summary.sessionDir; if (dir && path.basename(dir) === SESSION && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
  await step('remove scratch', async () => {
    for (let attempt = 1; ; attempt++) {
      try { rmSync(scratch, { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 12) throw error;
        await sleep(250);
      }
    }
  });
  await step('check', async () => {
    const list = await sessions();
    cleanup.sessionListed = list.some(({ name }) => name === SESSION);
    cleanup.sessionDirLeft = Boolean(summary.sessionDir && existsSync(summary.sessionDir));
    const defaultAfter = list.find((session) => session.default);
    summary.defaultSessionAfter = defaultAfter && { name: defaultAfter.name, running: defaultAfter.running };
  });
  summary.cleanup = cleanup;
  if (!failure && (cleanup.failures.length || cleanup.sessionListed || cleanup.sessionDirLeft)) failure = new Error('cleanup failed or left the session behind');
  summary.timingsMs = { ...summary.timingsMs, total: Date.now() - started };
  summary.passed = !failure;
  if (failure) summary.error = failure.stack ?? failure.message;

  const needles = [[scratch, '<scratch>'], [scratch.replace(/\\/g, '/'), '<scratch>'], [homedir(), '<home>'], [homedir().replace(/\\/g, '/'), '<home>'], [process.env.USERNAME ?? '', '<user>']].filter(([n]) => n);
  const clean = (value) => {
    if (typeof value === 'string') return needles.reduce((text, [needle, label]) => text.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(label), value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  console.log(JSON.stringify(clean(summary), null, 2));
  process.exitCode = failure ? 1 : 0;
}
