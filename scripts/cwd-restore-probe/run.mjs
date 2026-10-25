// End-to-end check of the plugin's hook-driven cwd-record / cwd-return pair (herdr issue #5199) in the named session
// `navigator-restore-probe` (Windows), with no shell configuration: a scratch herdr config and a scratch HOME whose
// .bashrc emits no OSC 7 and sets no title. See README.md. Every herdr call names `--session`, except the read-only
// `session list` / `plugin list` listings and `plugin link|unlink|config-dir`, which are global by design.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'navigator-restore-probe';
// The burst row's 2-pane side: a second scratch session, so its samples interleave with the 14-pane ones.
const BASE_SESSION = 'navigator-restore-probe-base';
const PLUGIN_ID = 'zenderx.herdr-navigator';
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PIPE_PREFIX = '\\\\.\\pipe\\';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const pluginDir = path.join(repoRoot, 'plugin');
const stateDir = path.join(process.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', PLUGIN_ID);
const recordFile = path.join(stateDir, `cwd-${SESSION}.txt`);
const instanceFile = path.join(stateDir, `cwd-${SESSION}.instance`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-restore-'));
const spawnDir = path.join(scratch, 'demo app@v1');
const subDir = path.join(spawnDir, 'sub dir');
const otherDir = path.join(scratch, 'other spawn');
const psDir = path.join(spawnDir, 'ps 5%');
// Title-less, no OSC 7: what a starship or custom prompt looks like to herdr. The stock-prompt pane gets an empty HOME.
const home = path.join(scratch, 'home');
const stockHome = path.join(scratch, 'stock home');
const configPath = path.join(scratch, 'config.toml');
for (const dir of [subDir, otherDir, psDir, home, stockHome]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(home, '.bashrc'), "PS1='$ '\nunset PROMPT_COMMAND\n");
const writeConfig = (shell, nonLogin) => writeFileSync(configPath,
  `onboarding = false\n\n[terminal]\ndefault_shell = "${shell}"\n${nonLogin ? 'shell_mode = "non_login"\n' : ''}`);

// herdr refuses nested launches keyed on HERDR_*, HERDR_NAV_* overrides would redirect the plugin's state, and an exported
// PS1 or PROMPT_COMMAND would survive into the panes; the config override is the only HERDR_* variable passed on.
const dropped = new Set(['PS1', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV', 'HOME']);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('HERDR_') && !dropped.has(key.toUpperCase()))),
  HOME: home,
  HERDR_CONFIG_PATH: configPath,
};

const started = Date.now();
const summary = { date: new Date(started).toISOString(), session: SESSION, timingsMs: {}, rows: {} };
let stateMtimesBefore = {};
const elapsed = (from) => Date.now() - from;

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const herdrIn = (session, ...args) => exec('herdr', ['--session', session, ...args]);
const herdr = (...args) => herdrIn(SESSION, ...args);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
async function herdrOkIn(session, ...args) {
  const result = await herdrIn(session, ...args);
  if (result.exit !== 0) throw new Error(`herdr --session ${session} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return json(result.stdout)?.result;
}
const herdrOk = (...args) => herdrOkIn(SESSION, ...args);

async function waitFor(label, check, ms, stepMs = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}`);
}

async function sessionInfo(session = SESSION) {
  return json((await exec('herdr', ['session', 'list', '--json'])).stdout)?.sessions.find(({ name }) => name === session);
}
const pluginLinked = async () => Boolean(json((await exec('herdr', ['plugin', 'list', '--json'])).stdout)?.result.plugins.some(({ plugin_id }) => plugin_id === PLUGIN_ID));

// herdr reports the spawn form with a trailing separator; compare folders loosely.
const norm = (folder) => folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const isSpawnForm = (cwd) => cwd.length > 3 && /[\\/]$/.test(cwd);
const fwd = (p) => p.replace(/\\/g, '/');
const bashQuote = (p) => `'${fwd(p).replace(/'/g, "'\\''")}'`;
const psQuote = (p) => `'${p.replace(/'/g, "''")}'`;
const panes = async () => (await herdrOk('pane', 'list'))?.panes ?? [];
const paneOf = (list, id) => list.find(({ pane_id }) => pane_id === id);
const paneCwd = (list, id) => paneOf(list, id)?.cwd;

// Record lines are "<id><TAB><live folder><TAB><spawn folder><TAB><shell pid><TAB><msys>".
function readRecord() {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));
}
const entry = (lines, id) => lines.find(([pane]) => pane === id);
// Stands in for an older writer: replaces the lines of the given ids, written whole as cwd-record does, while no hook runs.
function rewriteRecord(lines) {
  const ids = Object.keys(lines);
  const kept = readRecord().filter(([id]) => !ids.includes(id)).map((cols) => cols.join('\t'));
  writeFileSync(recordFile, [...kept, ...Object.values(lines)].map((line) => `${line}\n`).join(''));
}
async function processInfo(id) {
  return (await herdrOk('pane', 'process-info', '--pane', id))?.process_info;
}
// herdr's shell_pid (Git for Windows' bin\bash.exe launcher) and the pid of its one bash.exe child, the MSYS shell
// whose /proc cwd follows cd: the record's msys and pid columns.
async function shellPids(ids) {
  const herdrPid = {};
  for (const id of ids) herdrPid[id] = String((await processInfo(id))?.shell_pid);
  const script = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='bash.exe'" | ` +
    `Where-Object { @(${Object.values(herdrPid).join(',')}) -contains $_.ParentProcessId } | ForEach-Object { @{ parent = [string]$_.ParentProcessId; pid = [string]$_.ProcessId } })`;
  const children = json((await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout) ?? [];
  return Object.fromEntries(ids.map((id) => {
    const inner = children.filter(({ parent }) => parent === herdrPid[id]);
    if (inner.length !== 1) throw new Error(`pane ${id}: expected one bash.exe under the launcher ${herdrPid[id]}, found ${JSON.stringify(inner)}`);
    return [id, { herdr: herdrPid[id], inner: inner[0].pid }];
  }));
}
// What the shell itself says, typed into the pane: an independent check of where a restored shell is.
async function typedPwd(id) {
  const file = path.join(scratch, `pwd-${id.replace(/\W/g, '_')}.txt`);
  rmSync(file, { force: true });
  await herdrOk('pane', 'run', id, `pwd -W > ${bashQuote(file)}`);
  return waitFor(`pwd -W from ${id}`, () => (existsSync(file) ? readFileSync(file, 'utf8').trim() : ''), 15000);
}

// The extension's own batch probe (out/ from `npm run compile`), so the title-push row reads what the extension reads.
function loadExtensionProbe() {
  const require = createRequire(import.meta.url);
  const sources = [...readdirSync(path.join(repoRoot, 'src', 'cwd')).map((name) => path.join('cwd', name)), 'paths.ts', 'toolPaths.ts'];
  for (const source of sources) {
    const built = path.join(repoRoot, 'out', source.replace(/\.ts$/, '.js'));
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(path.join(repoRoot, 'src', source)).mtimeMs) throw new Error(`out/ is older than src/${source}; run npm run compile first`);
  }
  const { createMsysBatchProbe } = require(path.join(repoRoot, 'out', 'cwd', 'shellCwd.js'));
  const { nodeProbeDeps } = require(path.join(repoRoot, 'out', 'cwd', 'nodeDeps.js'));
  const probe = createMsysBatchProbe(nodeProbeDeps());
  return async (id, shellPid) => (await probe([{ paneId: id, shellPid: Number(shellPid) }], '')).get(id)?.cwd;
}

// One events.subscribe connection; every pushed pane_updated is kept with its arrival time.
async function listen(socketPath) {
  const state = { events: [] };
  const sock = net.connect(socketPath.startsWith(PIPE_PREFIX) ? socketPath : PIPE_PREFIX + socketPath);
  state.sock = sock;
  sock.setEncoding('utf8');
  let buffer = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no subscription_started within 5000 ms')), 5000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'listen', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.updated' }] } })}\n`));
    sock.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const message = json(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        if (message?.result?.type === 'subscription_started') {
          clearTimeout(timer);
          resolve();
        } else if (message?.error) {
          reject(new Error(`events.subscribe failed: ${JSON.stringify(message.error)}`));
        } else if (message?.event === 'pane_updated') {
          state.events.push({ at: Date.now(), pane: message.data?.pane ?? {} });
        }
      }
    });
    sock.on('error', reject);
  });
  return state;
}

// The hook design has no tracker: no cwd-track process, lock or error file may exist at any checkpoint.
async function assertNoTracker(checkpoint) {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='pwsh.exe'\" | " +
    "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*cwd-track*' } | ForEach-Object { $_.ProcessId }";
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const pids = stdout.split(/\r?\n/).filter(Boolean).map(Number);
  const files = existsSync(stateDir) ? readdirSync(stateDir).filter((name) => /\.(pid|err)$/.test(name) && !summary.stateFilesBefore.includes(name)) : [];
  summary.trackerChecks = [...(summary.trackerChecks ?? []), checkpoint];
  if (pids.length || files.length) throw new Error(`${checkpoint}: found tracker processes ${JSON.stringify(pids)} or files ${JSON.stringify(files)}`);
}

async function pluginLogs(sinceMs, script, session = SESSION) {
  const logs = json((await herdrIn(session, 'plugin', 'log', 'list', '--plugin', PLUGIN_ID, '--limit', '500')).stdout)?.result.logs ?? [];
  return logs.filter((log) => JSON.stringify(log).includes(script) && (log.finished_unix_ms ?? Number.MAX_SAFE_INTEGER) >= sinceMs);
}
const settled = (logs) => logs.every(({ status }) => status && status !== 'running');

// Every cwd-record hook run since `sinceMs` must have finished and succeeded; returns how many ran.
async function recordHooksSucceeded(sinceMs) {
  const logs = await waitFor('cwd-record hooks to finish', async () => {
    const list = await pluginLogs(sinceMs, 'cwd-record');
    return settled(list) ? list : undefined;
  }, 20000);
  const failed = logs.filter(({ status }) => status !== 'succeeded');
  if (failed.length) throw new Error(`cwd-record hook failed: ${JSON.stringify(failed[0])}`);
  return logs.length;
}
async function focus(workspace) {
  const at = Date.now();
  await herdrOk('workspace', 'focus', workspace);
  // Let the focus hooks start before checking they all finished.
  await sleep(1500);
  await recordHooksSucceeded(at);
  return at;
}

// The one cwd-return run since `sinceMs`: its stdout counts and how long it ran.
async function returnAfterStart(sinceMs) {
  const log = await waitFor('cwd-return startup log entry', async () => (await pluginLogs(sinceMs, 'cwd-return')).find(({ status }) => status && status !== 'running'), 45000);
  if (log.status !== 'succeeded') throw new Error(`cwd-return finished with status ${log.status}: ${JSON.stringify(log)}`);
  const entries = await pluginLogs(sinceMs, 'cwd-return');
  if (entries.length !== 1) throw new Error(`expected one cwd-return log entry since the start, found ${entries.length}`);
  const line = log.stdout?.trim() ?? '';
  const counts = /^cwd-return: (\d+) panes returned, (\d+) skipped(?: \((.*)\))?$/.exec(line);
  if (!counts) throw new Error(`unexpected cwd-return stdout: ${JSON.stringify(log.stdout)}`);
  const reasons = counts[3] ? Object.fromEntries(counts[3].split(', ').map((pair) => pair.split('='))) : {};
  const ranMs = log.started_unix_ms && log.finished_unix_ms ? log.finished_unix_ms - log.started_unix_ms : undefined;
  return { line, returned: Number(counts[1]), reasons, ranMs };
}
const sameReasons = (actual, expected) => JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());

function startServer(session = SESSION) {
  const server = spawn('herdr', ['--session', session, 'server'], { cwd: scratch, stdio: 'ignore', detached: true, env });
  server.unref();
  return waitFor(`server ${session} running`, async () => (await sessionInfo(session))?.running, 30000);
}
async function restart() {
  await exec('herdr', ['session', 'stop', SESSION]);
  await waitFor('server stopped', async () => !(await sessionInfo())?.running, 15000);
  await assertNoTracker('after session stop');
  const at = Date.now();
  await startServer();
  return at;
}
// herdr autosaves session.json 10-12 s after a change; a restart restores exactly the saved workspaces.
async function autosaved(workspaces, folder) {
  const at = Date.now();
  const sessionJson = path.join((await sessionInfo()).session_dir, 'session.json');
  await waitFor('autosave of the workspaces', () => {
    const saved = existsSync(sessionJson) ? json(readFileSync(sessionJson, 'utf8')) : undefined;
    const ids = (saved?.workspaces ?? []).map(({ id }) => id).sort();
    const cwds = (saved?.workspaces ?? []).flatMap(({ tabs }) => (tabs ?? []).flatMap(({ panes: list }) => Object.values(list ?? {}).map(({ cwd }) => norm(cwd ?? ''))));
    return JSON.stringify(ids) === JSON.stringify([...workspaces].sort()) && (!folder || cwds.includes(norm(folder)));
  }, 30000, 500);
  return elapsed(at);
}
async function createWorkspace(label, ...extra) {
  const result = await herdrOk('workspace', 'create', '--cwd', spawnDir, '--label', label, ...extra);
  if (!result) throw new Error(`workspace create ${label} returned no result`);
  return { workspace: result.workspace.workspace_id, pane: result.root_pane.pane_id };
}
async function splitPane(pane, ...extra) {
  const id = (await herdrOk('pane', 'split', pane, '--direction', 'right', ...extra))?.pane?.pane_id;
  if (!id) throw new Error(`pane split ${pane} returned no pane id`);
  return id;
}

// Every cwd-record hook started since `sinceMs`, once all have finished: each must have succeeded with no lock or error line.
async function cleanRecordHooks(label, sinceMs, session = SESSION) {
  const logs = await waitFor(`${label}: cwd-record hooks to finish`, async () => {
    const list = await pluginLogs(sinceMs, 'cwd-record', session);
    return settled(list) ? list : undefined;
  }, 90000, 500);
  const started = logs.filter(({ started_unix_ms }) => started_unix_ms >= sinceMs);
  const bad = started.filter((log) => log.status !== 'succeeded' || /stayed locked|cwd-record:/.test(`${log.stdout ?? ''}${log.stderr ?? ''}`));
  if (bad.length) throw new Error(`${label}: ${bad.length} of ${started.length} cwd-record hooks failed or logged an error, first: ${JSON.stringify(bad[0])}`);
  return started.map(({ started_unix_ms, finished_unix_ms }) => finished_unix_ms - started_unix_ms).sort((a, b) => a - b);
}
const median = (list) => list[Math.floor(list.length / 2)];
// Timed focuses per side, three hooks each: single 2-pane hooks vary 850-1600 ms on a desktop.
const STEADY_FOCUSES = 7;

// Row burst: hooks fired together must neither fail on the record lock nor cost more per hook as panes are added.
async function burstRow(extensionProbe) {
  const row = {};
  // A pane focus inside a tab fires workspace.focused, tab.focused and pane.focused; returns their hook wall times.
  const paneFocusMs = async (pane) => {
    const at = Date.now();
    const direction = pane.current === pane.root ? 'right' : 'left';
    await herdrOkIn(pane.session, 'pane', 'focus', '--direction', direction, '--pane', pane.current);
    pane.current = pane.current === pane.root ? pane.split : pane.root;
    await sleep(1500);
    return cleanRecordHooks(`${pane.session}: pane focus ${direction}`, at, pane.session);
  };
  const baseAt = Date.now();
  const base = await createWorkspace('burst base', '--no-focus');
  const baseSplit = await splitPane(base.pane, '--no-focus');
  await sleep(1500);
  await cleanRecordHooks('base create', baseAt);
  const basePanes = { session: SESSION, root: base.pane, split: baseSplit, current: base.pane };
  const twoAt = Date.now();
  await startServer(BASE_SESSION);
  summary.baseSessionDir = (await sessionInfo(BASE_SESSION)).session_dir;
  const two = await herdrOkIn(BASE_SESSION, 'workspace', 'create', '--cwd', spawnDir, '--label', 'burst two', '--no-focus');
  const twoSplit = (await herdrOkIn(BASE_SESSION, 'pane', 'split', two.root_pane.pane_id, '--direction', 'right', '--no-focus'))?.pane?.pane_id;
  await sleep(1500);
  await cleanRecordHooks(`${BASE_SESSION}: start and create`, twoAt, BASE_SESSION);
  const twoPanes = { session: BASE_SESSION, root: two.root_pane.pane_id, split: twoSplit, current: two.root_pane.pane_id };

  // Back to back, no wait for hooks: every create and split fires its own hooks while earlier ones still merge.
  const burstAt = Date.now();
  const made = [];
  for (let i = 1; i <= 6; i++) made.push(await createWorkspace(`burst ${i}`));
  const splits = [];
  for (const { pane } of made) splits.push(await splitPane(pane));
  row.createMs = Date.now() - burstAt;
  await sleep(1500);
  row.burstHookMs = await cleanRecordHooks('burst of creates', burstAt);
  const burstPanes = [...made.map(({ pane }) => pane), ...splits];
  const all = (await panes()).map(({ pane_id }) => pane_id);
  row.panes = all.length;
  if (burstPanes.length < 12) throw new Error(`burst made ${burstPanes.length} panes, not 12`);

  const moved = Object.fromEntries([...made.slice(0, 3).map(({ pane }) => pane), ...splits.slice(3)].map((id, i) => [id, path.join(spawnDir, `burst cd ${i + 1}`)]));
  for (const [id, folder] of Object.entries(moved)) {
    mkdirSync(folder, { recursive: true });
    await herdrOk('pane', 'run', id, `cd ${bashQuote(folder)}`);
  }
  for (const [id, folder] of Object.entries(moved)) {
    const shellPid = String((await processInfo(id))?.shell_pid);
    await waitFor(`the burst shell of ${id} in its cd folder`, async () => norm((await extensionProbe(id, shellPid)) ?? '') === norm(folder), 15000);
  }
  // One focus to another space fires workspace.focused, tab.focused and pane.focused at once. Creates leave the base space focused.
  const focusAt = Date.now();
  await herdrOk('workspace', 'focus', made[0].workspace);
  await sleep(1500);
  row.focusHookMs = await cleanRecordHooks('focus after the burst', focusAt);
  const lines = readRecord();
  const missing = all.filter((id) => !entry(lines, id));
  if (missing.length || lines.length !== all.length) throw new Error(`record has ${lines.length} lines for ${all.length} panes, missing ${missing.join(', ')}`);
  for (const [id, folder] of Object.entries(moved)) {
    if (norm(entry(lines, id)[1] ?? '') !== norm(folder)) throw new Error(`burst pane ${id} recorded ${entry(lines, id)[1]}, not its cd folder ${folder}`);
  }
  row.focusRecordMs = Date.now() - focusAt;
  const backAt = Date.now();
  await herdrOk('workspace', 'focus', base.workspace);
  await sleep(1500);
  await cleanRecordHooks('focus back to the base space', backAt);
  const twoCount = (await herdrOkIn(BASE_SESSION, 'pane', 'list'))?.panes?.length;
  if (twoCount !== 2) throw new Error(`${BASE_SESSION} has ${twoCount} panes, not 2`);
  // Steady state, 2 panes and all panes taken in turn so machine drift hits both sides; the first pair seeds the
  // panes the create hooks saw before their MSYS shell existed.
  row.steadyMs2Panes = [];
  row.steadyMsAllPanes = [];
  for (let i = 0; i <= STEADY_FOCUSES; i++) {
    const [twoMs, allMs] = [await paneFocusMs(twoPanes), await paneFocusMs(basePanes)];
    if (i > 0) {
      row.steadyMs2Panes.push(...twoMs);
      row.steadyMsAllPanes.push(...allMs);
    }
  }
  row.steadyMs2Panes.sort((a, b) => a - b);
  row.steadyMsAllPanes.sort((a, b) => a - b);
  const [twoMedian, many] = [median(row.steadyMs2Panes), median(row.steadyMsAllPanes)];
  if (many > 2000 || many > 1.5 * twoMedian) throw new Error(`steady hook median ${many} ms with ${row.panes} panes vs ${twoMedian} ms with 2: the hook cost grows with the pane count`);
  await exec('herdr', ['session', 'stop', BASE_SESSION]);

  const closeAt = Date.now();
  for (const { workspace } of [base, ...made]) await herdrOk('workspace', 'close', workspace);
  await sleep(1500);
  // A closing pane can vanish between a hook's pane list and its process-info, which logs a line, so only the status counts here.
  await recordHooksSucceeded(closeAt);
  return row;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('this check drives the PowerShell scripts and runs on Windows only');
  for (const session of [SESSION, BASE_SESSION]) if (await sessionInfo(session)) throw new Error(`session ${session} already exists`);
  if (await pluginLinked()) throw new Error(`${PLUGIN_ID} is already linked or installed; unlink it first so the cleanup cannot remove your copy`);
  summary.configDirExisted = existsSync(path.join(process.env.APPDATA ?? '', 'herdr', 'plugins', 'config', PLUGIN_ID));
  summary.stateDirExisted = existsSync(stateDir);
  summary.stateFilesBefore = summary.stateDirExisted ? readdirSync(stateDir) : [];
  stateMtimesBefore = Object.fromEntries(summary.stateFilesBefore.map((name) => [name, statSync(path.join(stateDir, name)).mtimeMs]));
  if (summary.stateFilesBefore.some((name) => name.includes(SESSION))) throw new Error(`state files for ${SESSION} already exist in the plugin state dir`);
  const extensionProbe = loadExtensionProbe();
  writeConfig(GIT_BASH, true);

  const link = await exec('herdr', ['plugin', 'link', pluginDir]);
  if (link.exit !== 0) throw new Error(`plugin link failed: ${link.stderr || link.stdout}`);
  summary.linked = true;

  const firstStart = Date.now();
  await startServer();
  summary.sessionDir = (await sessionInfo()).session_dir;
  const first = await returnAfterStart(firstStart);
  summary.firstStart = { cwdReturn: first.line, ms: elapsed(firstStart) };
  await assertNoTracker('after first start');
  // cwd-return's final merge stamps the server run; hooks of the same run may then update the record.
  if (!existsSync(instanceFile)) throw new Error('cwd-return wrote no server-run stamp at the first start');
  summary.rows.stamp = 'first cwd-return succeeded and wrote the server-run stamp';
  const socket = await listen((await sessionInfo()).socket_path);
  summary.rows.burst = await burstRow(extensionProbe);

  // moved: cd, then a hook. control: never cd'd, its line made legacy. unknown / mismatch: spawn check rows. gap: cd with no
  // event after it. stock: Git for Windows' own prompt, whose title push follows a cd.
  const labels = ['moved', 'control', 'unknown', 'mismatch', 'gap'];
  const created = {};
  // One create at a time, each waiting for its hooks, so a failing hook names its create; the burst row covers back-to-back creates.
  for (const label of [...labels, 'stock']) {
    const at = Date.now();
    created[label] = await createWorkspace(label, '--no-focus', ...(label === 'stock' ? ['--env', `HOME=${stockHome}`] : []));
    await sleep(1500);
    await recordHooksSucceeded(at);
  }
  const ids = Object.fromEntries(Object.entries(created).map(([label, { pane }]) => [label, pane]));
  const all = Object.values(ids);
  const titleless = labels.map((label) => ids[label]);
  await waitFor('the stock prompt title', async () => /^(MINGW|MSYS|UCRT|CLANG)\w*:/.test(paneOf(await panes(), ids.stock)?.terminal_title_stripped ?? ''), 20000);
  summary.recordHooksAfterCreate = await recordHooksSucceeded(firstStart);

  // The create hooks may run before the launcher's MSYS child exists, so one focus hook seeds every line.
  await focus(created.control.workspace);
  const pids = await shellPids(all);
  const seeded = await waitFor('every line seeded with spawn, pid and msys', () => {
    const lines = readRecord();
    return all.every((id) => {
      const [, live, spawnFolder, pid, msys] = entry(lines, id) ?? [];
      return live && norm(live) === norm(spawnDir) && spawnFolder && norm(spawnFolder) === norm(spawnDir) && pid === pids[id].inner && msys === pids[id].herdr;
    }) ? lines : undefined;
  }, 10000);
  summary.recordAfterCreate = seeded.map((cols) => cols.join('\t'));
  summary.rows.seed = 'every line holds live and spawn = the spawn folder, the MSYS shell pid and herdr\'s shell_pid';
  // Row legacy: a line from the old two-column layout, with no spawn folder or pid.
  rewriteRecord({ [ids.control]: `${ids.control}\t${spawnDir}` });

  const cdPanes = [ids.moved, ids.unknown, ids.mismatch];
  const cdAt = Date.now();
  for (const id of cdPanes) await herdrOk('pane', 'run', id, `cd ${bashQuote(subDir)}`);
  await waitFor('the MSYS shells of the cd panes in the sub dir', async () => {
    for (const id of cdPanes) if (norm((await extensionProbe(id, pids[id].herdr)) ?? '') !== norm(subDir)) return false;
    return true;
  }, 15000);
  // With no hook event since the cd, nothing may have recorded it: proves the record follows hooks, not a timer.
  await sleep(4000);
  const quiet = entry(readRecord(), ids.moved);
  if (quiet?.[1] && norm(quiet[1]) === norm(subDir)) throw new Error('the record caught the cd with no hook event in between');
  summary.rows['no-timer'] = `4 s after the cd, with no hook, the line still says ${quiet?.[1]}`;

  // Focusing the space that already has focus fires no hook, so focus another one.
  const focusAt = await focus(created.moved.workspace);
  const recordLines = await waitFor('record lists the sub dir for the cd panes and seeds the legacy line after a focus hook', () => {
    const lines = readRecord();
    const [, controlLive, controlSpawn, controlPid] = entry(lines, ids.control) ?? [];
    return cdPanes.every((id) => entry(lines, id)?.[1] && norm(entry(lines, id)[1]) === norm(subDir)) &&
      controlLive && norm(controlLive) === norm(spawnDir) && controlSpawn && norm(controlSpawn) === norm(spawnDir) && controlPid === pids[ids.control].inner ? lines : undefined;
  }, 15000);
  summary.timingsMs.recordAfterFocus = elapsed(focusAt);
  summary.timingsMs.cdToRecord = elapsed(cdAt);
  // The zero-config claim: herdr still reports the spawn folder while the record holds the shell's live folder.
  const listAtHook = await panes();
  for (const id of cdPanes) {
    const cwd = paneCwd(listAtHook, id) ?? '';
    if (!isSpawnForm(cwd) || norm(cwd) !== norm(spawnDir)) throw new Error(`pane list cwd of ${id} is ${cwd}, not the spawn form of the spawn folder: OSC 7 reached herdr`);
  }
  summary.rows['record-on-hook'] = { paneListCwd: paneCwd(listAtHook, ids.moved), recordLine: entry(recordLines, ids.moved).join('\t') };
  summary.rows.legacy = `legacy line of ${ids.control} seeded at the focus hook: ${entry(recordLines, ids.control).join('\t')}`;
  if (recordLines.some(([, live, spawnFolder]) => isSpawnForm(live ?? '') || isSpawnForm(spawnFolder ?? ''))) throw new Error('record holds a spawn-form folder');
  await assertNoTracker('after the focus hook');

  // Row title-push: the stock prompt's cd pushes pane_updated (cwd still spawn form, title = the MSYS path); the
  // extension probes on that event and reads the new folder. The plugin has no hook for it, so its line stays.
  const stockAt = Date.now();
  await herdrOk('pane', 'run', ids.stock, `cd ${bashQuote(subDir)}`);
  const push = await waitFor('pane_updated with the stock title of the sub dir', () => socket.events.find((e) => e.at >= stockAt && e.pane.pane_id === ids.stock && (e.pane.terminal_title_stripped ?? '').endsWith('/sub dir')), 10000, 20);
  const pushedRead = await extensionProbe(ids.stock, pids[ids.stock].herdr);
  if (!isSpawnForm(push.pane.cwd ?? '')) throw new Error(`the stock prompt push carries a live cwd ${push.pane.cwd}: OSC 7 reached herdr`);
  if (norm(pushedRead ?? '') !== norm(subDir)) throw new Error(`the extension's probe read ${pushedRead} on the push, not the sub dir`);
  summary.rows['title-push'] = { pushMs: push.at - stockAt, pushedCwd: push.pane.cwd, title: push.pane.terminal_title_stripped, extensionProbe: pushedRead, pluginLine: entry(readRecord(), ids.stock)?.join('\t') };

  // Row gap (known limit): a title-less cd fires no event, so the record keeps the folder of the last hook.
  await herdrOk('pane', 'run', ids.gap, `cd ${bashQuote(subDir)}`);
  await waitFor('the gap shell in the sub dir', async () => norm((await extensionProbe(ids.gap, pids[ids.gap].herdr)) ?? '') === norm(subDir), 15000);
  const titles = await panes();
  for (const id of titleless) if (paneOf(titles, id)?.terminal_title_stripped) throw new Error(`pane ${id} has the title ${paneOf(titles, id).terminal_title_stripped}; the scratch prompt must set none`);
  const pushesFromTitleless = socket.events.filter((e) => e.at >= cdAt && titleless.includes(e.pane.pane_id)).length;
  if (pushesFromTitleless) throw new Error(`${pushesFromTitleless} pane_updated pushes came from title-less panes`);

  // Row launcher-cwd: the launcher's process cwd, which herdr persists, never left the spawn folder.
  const movedInfo = await processInfo(ids.moved);
  const preStopCwd = movedInfo?.foreground_processes?.find(({ pid }) => pid === movedInfo.shell_pid)?.cwd;

  summary.timingsMs.autosaveWait = await autosaved(Object.values(created).map(({ workspace }) => workspace));
  // Rows unknown-spawn and mismatch, written after the last hook and right before the stop.
  rewriteRecord({ [ids.unknown]: `${ids.unknown}\t${subDir}`, [ids.mismatch]: `${ids.mismatch}\t${subDir}\t${otherDir}\t${pids[ids.mismatch].inner}` });
  const atStop = readRecord();
  summary.recordAtStop = atStop.map((cols) => cols.join('\t'));
  const gapLine = entry(atStop, ids.gap) ?? [];
  if (!gapLine[1] || norm(gapLine[1]) !== norm(spawnDir)) throw new Error(`the gap pane's line changed with no hook: ${gapLine.join('\t')}`);
  const stockLine = entry(atStop, ids.stock) ?? [];
  if (!stockLine[1] || norm(stockLine[1]) !== norm(spawnDir)) throw new Error(`the stock pane's line changed with no hook: ${stockLine.join('\t')}`);

  const secondStart = await restart();
  const restoredSpawn = await waitFor('the restored moved pane', async () => paneCwd(await panes(), ids.moved), 15000, 100);
  const second = await returnAfterStart(secondStart);
  summary.cwdReturnLogLine = second.line;
  summary.timingsMs.returnAfterRestart = elapsed(secondStart);
  summary.timingsMs.cwdReturnRan = second.ranMs;
  if (second.returned !== 1 || !sameReasons(second.reasons, { same: '3', 'unknown-spawn': '1', mismatch: '1' })) throw new Error(`unexpected cwd-return stdout: ${second.line}`);
  // A Git Bash pane is ready once its MSYS shell resolves; a prompt wait would run into the 20 s ready timeout.
  if (second.ranMs !== undefined && second.ranMs >= 20000) throw new Error(`cwd-return ran ${second.ranMs} ms: it waited for a prompt`);

  const where = {};
  for (const id of all) where[id] = await typedPwd(id);
  summary.afterRestart = where;
  const listAfter = await panes();
  if (norm(where[ids.moved]) !== norm(subDir)) throw new Error(`moved pane not returned: its shell is in ${where[ids.moved]}`);
  if (!isSpawnForm(paneCwd(listAfter, ids.moved) ?? '')) throw new Error(`pane list cwd of the moved pane is live (${paneCwd(listAfter, ids.moved)}): OSC 7 reached herdr`);
  for (const id of [ids.control, ids.unknown, ids.mismatch, ids.gap, ids.stock]) if (norm(where[id]) !== norm(spawnDir)) throw new Error(`pane ${id} is not in its spawn folder after the restart: ${where[id]}`);
  summary.rows.return = `${ids.moved} returned: pwd -W ${where[ids.moved]}, pane list cwd ${paneCwd(listAfter, ids.moved)}`;
  summary.rows['unknown-spawn'] = `${ids.unknown} skipped unknown-spawn, stays in ${where[ids.unknown]}`;
  summary.rows.mismatch = `${ids.mismatch} skipped mismatch, stays in ${where[ids.mismatch]}`;
  summary.rows.gap = `known limit: ${ids.gap} cd'd with no event before the stop; recorded ${gapLine[1]}, counted same, stays in ${where[ids.gap]}`;
  summary.rows['launcher-cwd'] = { preStopProcessInfoCwd: preStopCwd, restoredSpawn };
  if (!preStopCwd || norm(preStopCwd) !== norm(spawnDir) || norm(restoredSpawn) !== norm(spawnDir)) throw new Error(`pre-stop launcher cwd ${preStopCwd} or restored spawn ${restoredSpawn} is not the spawn folder`);

  // cwd-return's final merge stores each restored shell's live folder, spawn folder and new pids.
  const after = readRecord();
  summary.recordAfterRestart = after.map((cols) => cols.join('\t'));
  const newPids = await shellPids(all);
  for (const id of all) {
    const [, live, spawnFolder, pid, msys] = entry(after, id) ?? [];
    if (!live || norm(live) !== norm(id === ids.moved ? subDir : spawnDir)) throw new Error(`record holds the wrong live folder for ${id} after the restart: ${live}`);
    if (!spawnFolder || norm(spawnFolder) !== norm(spawnDir)) throw new Error(`record holds no restored spawn folder for ${id}: ${spawnFolder}`);
    if (pid !== newPids[id].inner || msys !== newPids[id].herdr || pid === pids[id].inner) throw new Error(`record holds pids ${pid}/${msys} for ${id}, not the restored shell's ${newPids[id].inner}/${newPids[id].herdr}`);
  }
  summary.rows['record-after'] = `${all.length} lines hold the live folder, the restored spawn folder and the restored shells' new pids`;
  summary.recordHooksAfterRestart = await recordHooksSucceeded(secondStart);
  await assertNoTracker('after the restart');

  // Row powershell: herdr's own wrapper reports PowerShell's folder and herdr restores it, so the return is same.
  for (const { workspace } of Object.values(created)) await herdrOk('workspace', 'close', workspace);
  writeConfig(POWERSHELL, false);
  await herdrOk('server', 'reload-config');
  const ps = await createWorkspace('powershell', '--no-focus');
  const psControl = await createWorkspace('powershell-control', '--no-focus');
  for (const { pane } of [ps, psControl]) {
    const argv0 = await waitFor('PowerShell process info', async () => (await processInfo(pane))?.foreground_processes?.[0]?.argv0, 10000);
    if (!/powershell/i.test(argv0)) throw new Error(`pane ${pane} runs ${argv0}, not PowerShell; reload-config did not switch the shell`);
    await waitFor('the first PowerShell prompt', async () => !isSpawnForm(paneCwd(await panes(), pane) ?? '/'), 20000);
  }
  await herdrOk('pane', 'run', ps.pane, `Set-Location ${psQuote(psDir)}`);
  await waitFor('pane list cwd of the PowerShell pane in its new folder', async () => norm(paneCwd(await panes(), ps.pane) ?? '') === norm(psDir), 10000);
  await focus(psControl.workspace);
  const psLine = await waitFor('the PowerShell line with the new folder', () => {
    const line = entry(readRecord(), ps.pane);
    return line?.[1] && norm(line[1]) === norm(psDir) ? line : undefined;
  }, 10000);
  summary.timingsMs.psAutosaveWait = await autosaved([ps.workspace, psControl.workspace], psDir);
  const thirdStart = await restart();
  const third = await returnAfterStart(thirdStart);
  const psRestored = await waitFor('the restored PowerShell pane past its first prompt', async () => {
    const cwd = paneCwd(await panes(), ps.pane);
    return cwd && !isSpawnForm(cwd) ? cwd : undefined;
  }, 20000);
  if (third.returned !== 0 || !sameReasons(third.reasons, { same: '2' }) || norm(psRestored) !== norm(psDir)) throw new Error(`PowerShell restart: ${third.line}, restored in ${psRestored}`);
  summary.rows.powershell = { recordLine: psLine.join('\t'), cwdReturn: third.line, restoredCwd: psRestored };
  await assertNoTracker('after the PowerShell restart');
  socket.sock.destroy();
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  if ((await sessionInfo())?.running) {
    summary.diagnostics = {
      panes: (await herdr('pane', 'list')).stdout,
      record: readRecord().map((cols) => cols.join('\t')),
      pluginLog: await pluginLogs(0, 'cwd-'),
    };
  }
} finally {
  // Every step runs even when an earlier one throws, so the summary is always printed and what was left is named.
  const cleanup = { failures: [] };
  const step = async (name, run) => {
    try { await run(); } catch (error) { cleanup.failures.push(`${name}: ${error.message}`); }
  };
  // A live-session hook holds its lock file open with no sharing while it merges; such a file is reported, not fatal.
  const removeStateFile = async (name) => {
    for (let attempt = 1; ; attempt++) {
      try { rmSync(path.join(stateDir, name), { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 12) { cleanup.failures.push(`remove ${name}: ${error.code ?? error.message}`); return; }
        await sleep(250);
      }
    }
  };
  for (const session of [SESSION, BASE_SESSION]) await step(`session stop ${session}`, () => exec('herdr', ['session', 'stop', session]));
  await sleep(1000);
  for (const session of [SESSION, BASE_SESSION]) await step(`session delete ${session}`, () => exec('herdr', ['session', 'delete', session]));
  // Only the scratch sessions' own dirs are ever removed here.
  for (const [dir, session] of [[summary.sessionDir, SESSION], [summary.baseSessionDir, BASE_SESSION]]) {
    await step(`remove session dir ${session}`, () => { if (dir && path.basename(dir) === session && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
  }
  if (summary.linked) {
    let configDir = '';
    await step('plugin config-dir', async () => { configDir = (await exec('herdr', ['plugin', 'config-dir', PLUGIN_ID])).stdout; });
    await step('plugin unlink', () => exec('herdr', ['plugin', 'unlink', PLUGIN_ID]));
    // herdr creates the config dir before every plugin command; remove it only when this run created it empty.
    await step('remove config dir', () => { if (!summary.configDirExisted && configDir.includes(PLUGIN_ID) && existsSync(configDir) && readdirSync(configDir).length === 0) rmdirSync(configDir); });
    // Per-session files of other sessions that the global link made their hooks create or rewrite; discovery.state is shared by every session.
    await step('list live-session writes', () => {
      if (!existsSync(stateDir)) return;
      summary.liveSessionWrites = readdirSync(stateDir).filter((name) => !name.includes(SESSION) && name !== 'discovery.state'
        && statSync(path.join(stateDir, name), { throwIfNoEntry: false })?.mtimeMs !== stateMtimesBefore[name]);
    });
    // Files that existed before the run are never removed, whatever their name; only files the run (or its link) created go.
    await step('remove state files', async () => {
      if (!existsSync(stateDir)) return;
      const created = readdirSync(stateDir).filter((name) => !summary.stateFilesBefore.includes(name));
      summary.leftoverTrackerFiles = created.filter((name) => /\.(pid|err)$/.test(name));
      for (const name of created) await removeStateFile(name);
      summary.stateFilesRemoved = created.filter((name) => !existsSync(path.join(stateDir, name)));
      if (!summary.stateDirExisted && readdirSync(stateDir).length === 0) rmdirSync(stateDir);
    });
  }
  await step('remove scratch', () => rmSync(scratch, { recursive: true, force: true }));
  await step('check', async () => {
    cleanup.sessionListed = Boolean(await sessionInfo()) || Boolean(await sessionInfo(BASE_SESSION));
    cleanup.sessionDirLeft = [summary.sessionDir, summary.baseSessionDir].some((dir) => dir && existsSync(dir));
    cleanup.pluginListed = await pluginLinked();
    cleanup.stateFilesLeft = existsSync(stateDir) ? readdirSync(stateDir).filter((name) => !summary.stateFilesBefore.includes(name)) : [];
  });
  summary.cleanup = cleanup;
  const dirty = cleanup.failures.length > 0 || cleanup.sessionListed || cleanup.sessionDirLeft || cleanup.pluginListed || cleanup.stateFilesLeft.length > 0;
  summary.timingsMs.total = elapsed(started);
  if (!failure && summary.leftoverTrackerFiles?.length) failure = new Error('a lock or error file was written');
  if (!failure && dirty) failure = new Error('cleanup failed or left the session, the plugin link or state files behind');
  if (!failure && summary.timingsMs.total > 180000) failure = new Error('the run took longer than 3 minutes');
  summary.passed = !failure;
  if (failure) summary.error = failure.message;

  const needles = [[scratch, '<scratch>'], [fwd(scratch), '<scratch>'], [homedir(), '<home>'], [fwd(homedir()), '<home>'], [process.env.USERNAME ?? '', '<user>']].filter(([n]) => n);
  const clean = (value) => {
    if (typeof value === 'string') return needles.reduce((text, [needle, label]) => text.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(label), value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  console.log(JSON.stringify(clean(summary), null, 2));
  process.exitCode = failure ? 1 : 0;
}
