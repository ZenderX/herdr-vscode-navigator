// End-to-end check of the plugin's cwd-return / cwd-track pair (herdr issue #5199) in the named session
// `navigator-restore-probe` (Windows). See README.md. Every herdr call names `--session`, except the read-only
// `session list` / `plugin list` listings and `plugin link|unlink|config-dir`, which are global by design.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'navigator-restore-probe';
const PLUGIN_ID = 'zenderx.herdr-navigator';
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..', '..', 'plugin');
const stateDir = path.join(process.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', PLUGIN_ID);
const recordFile = path.join(stateDir, `cwd-${SESSION}.txt`);
const lockFile = path.join(stateDir, `cwd-track-${SESSION}.pid`);
const errFile = path.join(stateDir, `cwd-track-${SESSION}.err`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-restore-'));
const spawnDir = path.join(scratch, 'demo app@v1');
const subDir = path.join(spawnDir, 'sub dir');
mkdirSync(subDir, { recursive: true });

// herdr refuses nested launches keyed on HERDR_*, and HERDR_NAV_* overrides would redirect the plugin's state.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));

const started = Date.now();
const summary = { date: new Date(started).toISOString(), session: SESSION, timingsMs: {} };
const elapsed = (from) => Date.now() - from;

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const herdr = (...args) => exec('herdr', ['--session', SESSION, ...args]);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

async function waitFor(label, check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}`);
}

async function sessionInfo() {
  return json((await exec('herdr', ['session', 'list', '--json'])).stdout)?.sessions.find(({ name }) => name === SESSION);
}
const pluginLinked = async () => Boolean(json((await exec('herdr', ['plugin', 'list', '--json'])).stdout)?.result.plugins.some(({ plugin_id }) => plugin_id === PLUGIN_ID));

// herdr reports the spawn form with a trailing separator and the OSC 7 form without; compare folders loosely.
const norm = (folder) => folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const isSpawnForm = (cwd) => cwd.length > 3 && /[\\/]$/.test(cwd);
async function panes() {
  return json((await herdr('pane', 'list')).stdout)?.result.panes ?? [];
}
const paneCwd = (list, id) => list.find(({ pane_id }) => pane_id === id)?.cwd;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
const lockPid = () => (existsSync(lockFile) ? Number(readFileSync(lockFile, 'utf8').trim()) : undefined);

// Counts powershell processes running cwd-track.ps1 for this session, excluding the counting process itself.
async function trackerPids() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='pwsh.exe'\" | " +
    `Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*cwd-track.ps1*' -and $_.CommandLine -like '*${SESSION}*' } | ` +
    'ForEach-Object { $_.ProcessId }';
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return stdout.split(/\r?\n/).filter(Boolean).map(Number);
}

async function cwdReturnEntries(sinceMs) {
  const logs = json((await herdr('plugin', 'log', 'list', '--plugin', PLUGIN_ID, '--limit', '50')).stdout)?.result.logs ?? [];
  return logs.filter((entry) => JSON.stringify(entry).includes('cwd-return') && (entry.finished_unix_ms ?? 0) >= sinceMs);
}
const finishedReturn = async (sinceMs) => (await cwdReturnEntries(sinceMs)).find(({ status }) => status && status !== 'running');

function startServer() {
  const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd: scratch, stdio: 'ignore', detached: true, env });
  server.unref();
  return waitFor('server running', async () => (await sessionInfo())?.running, 30000);
}

// Waits for the tracker to exit after `session stop` and checks it removed its lock.
async function stopAndWatchTracker(pid) {
  const stopAt = Date.now();
  await exec('herdr', ['session', 'stop', SESSION]);
  await waitFor('tracker exit after session stop', () => !alive(pid) && !existsSync(lockFile), 15000);
  return elapsed(stopAt);
}

async function trackerAfterStart(sinceMs) {
  const entry = await waitFor('cwd-return startup log entry', () => finishedReturn(sinceMs), 45000);
  if (entry.status !== 'succeeded') throw new Error(`cwd-return finished with status ${entry.status}: ${JSON.stringify(entry)}`);
  const pid = await waitFor('tracker lock file', () => (lockPid() && alive(lockPid()) ? lockPid() : undefined), 15000);
  return { entry, pid };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('this check drives the PowerShell scripts and runs on Windows only');
  if (await sessionInfo()) throw new Error(`session ${SESSION} already exists`);
  if (await pluginLinked()) throw new Error(`${PLUGIN_ID} is already linked or installed; unlink it first so the cleanup cannot remove your copy`);
  summary.configDirExisted = existsSync(path.join(process.env.APPDATA ?? '', 'herdr', 'plugins', 'config', PLUGIN_ID));
  summary.stateDirExisted = existsSync(stateDir);
  summary.stateFilesBefore = summary.stateDirExisted ? readdirSync(stateDir) : [];
  if (summary.stateFilesBefore.some((name) => name.includes(SESSION))) throw new Error(`state files for ${SESSION} already exist in the plugin state dir`);

  const link = await exec('herdr', ['plugin', 'link', pluginDir]);
  if (link.exit !== 0) throw new Error(`plugin link failed: ${link.stderr || link.stdout}`);
  summary.linked = true;

  const firstStart = Date.now();
  await startServer();
  const first = await trackerAfterStart(firstStart);
  summary.firstStart = { cwdReturnStdout: first.entry.stdout?.trim(), trackerPid: first.pid, ms: elapsed(firstStart) };

  const created = {};
  for (const label of ['moved', 'control']) {
    const result = json((await herdr('workspace', 'create', '--cwd', spawnDir, '--label', label)).stdout)?.result;
    if (!result) throw new Error(`workspace create ${label} failed`);
    created[label] = { workspace: result.workspace.workspace_id, pane: result.root_pane.pane_id };
  }
  const moved = created.moved.pane;
  const control = created.control.pane;
  // The cd is typed only after the first prompt, as cwd-return itself does.
  await waitFor('first prompt in both panes', async () => {
    const list = await panes();
    return [moved, control].every((id) => paneCwd(list, id) && !isSpawnForm(paneCwd(list, id)));
  }, 20000);

  const cdAt = Date.now();
  const run = await herdr('pane', 'run', moved, `cd '${subDir.replace(/'/g, "'\\''")}'`);
  if (run.exit !== 0) throw new Error(`pane run failed: ${run.stderr || run.stdout}`);
  const recordLines = await waitFor('record lists the sub dir for the moved pane', () => {
    if (!existsSync(recordFile)) return undefined;
    const lines = readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));
    const folder = (id) => lines.find(([pane]) => pane === id)?.[1];
    return folder(moved) && norm(folder(moved)) === norm(subDir) && folder(control) && norm(folder(control)) === norm(spawnDir) ? lines : undefined;
  }, 15000);
  summary.timingsMs.recordWait = elapsed(cdAt);
  summary.record = recordLines.map((cols) => cols.join('\t'));
  if (recordLines.some(([, folder]) => isSpawnForm(folder))) throw new Error('record holds a spawn-form folder');

  // herdr autosaves session.json 10-12 s after a change; the restart restores only what was saved.
  const saveAt = Date.now();
  const sessionJson = path.join((await sessionInfo()).session_dir, 'session.json');
  await waitFor('autosave of both workspaces', () => {
    const saved = existsSync(sessionJson) ? json(readFileSync(sessionJson, 'utf8')) : undefined;
    return [created.moved.workspace, created.control.workspace].every((id) => saved?.workspaces?.some((ws) => ws.id === id));
  }, 30000);
  summary.timingsMs.autosaveWait = elapsed(saveAt);

  summary.timingsMs.trackerExitAfterStop = await stopAndWatchTracker(first.pid);
  await waitFor('server stopped', async () => !(await sessionInfo())?.running, 15000);

  const secondStart = Date.now();
  await startServer();
  const returned = await waitFor('moved pane back in the sub dir', async () => {
    const list = await panes();
    const movedCwd = paneCwd(list, moved);
    const controlCwd = paneCwd(list, control);
    return movedCwd && norm(movedCwd) === norm(subDir) && controlCwd && norm(controlCwd) === norm(spawnDir) ? { movedCwd, controlCwd } : undefined;
  }, 30000);
  summary.timingsMs.returnAfterRestart = elapsed(secondStart);
  summary.afterRestart = { [moved]: returned.movedCwd, [control]: returned.controlCwd };

  const second = await trackerAfterStart(secondStart);
  summary.cwdReturnLogLine = second.entry.stdout?.trim();
  if (!/^cwd-return: 1 panes returned, 1 skipped \(same=1\)$/.test(summary.cwdReturnLogLine ?? '')) {
    throw new Error(`unexpected cwd-return stdout: ${JSON.stringify(second.entry.stdout)}`);
  }
  const entries = await cwdReturnEntries(secondStart);
  if (entries.length !== 1) throw new Error(`expected one cwd-return log entry after the restart, found ${entries.length}`);

  const trackers = await trackerPids();
  summary.trackersAfterRestart = trackers.length;
  if (trackers.length !== 1 || trackers[0] !== second.pid) throw new Error(`expected one tracker (lock PID ${second.pid}), found ${JSON.stringify(trackers)}`);
  if (alive(first.pid)) throw new Error(`first tracker ${first.pid} is still alive`);

  summary.timingsMs.trackerExitAfterFinalStop = await stopAndWatchTracker(second.pid);
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  if ((await sessionInfo())?.running) {
    summary.diagnostics = {
      panes: (await panes()).map(({ pane_id, cwd }) => ({ pane_id, cwd })),
      cwdReturnLog: await cwdReturnEntries(0),
    };
  }
} finally {
  if (existsSync(errFile)) summary.trackerError = readFileSync(errFile, 'utf8').trim();
  await exec('herdr', ['session', 'stop', SESSION]);
  await sleep(1000);
  await exec('herdr', ['session', 'delete', SESSION]);
  if (summary.linked) {
    const configDir = (await exec('herdr', ['plugin', 'config-dir', PLUGIN_ID])).stdout;
    await exec('herdr', ['plugin', 'unlink', PLUGIN_ID]);
    // herdr creates the config dir before every plugin command; remove it only when this run created it empty.
    if (!summary.configDirExisted && configDir.includes(PLUGIN_ID) && existsSync(configDir) && readdirSync(configDir).length === 0) rmdirSync(configDir);
    // A tracker that outlived the session must not rewrite the files deleted below; it counts as a failure.
    const pid = lockPid();
    if (pid && alive(pid)) {
      process.kill(pid);
      summary.trackerKilledAtCleanup = pid;
    }
    if (existsSync(stateDir)) {
      const created = readdirSync(stateDir).filter((name) => !summary.stateFilesBefore.includes(name));
      for (const name of created) rmSync(path.join(stateDir, name), { force: true });
      summary.stateFilesRemoved = created;
      if (!summary.stateDirExisted && readdirSync(stateDir).length === 0) rmdirSync(stateDir);
    }
  }
  rmSync(scratch, { recursive: true, force: true });

  summary.cleanup = {
    sessionListed: Boolean(await sessionInfo()),
    pluginListed: await pluginLinked(),
    stateFilesLeft: existsSync(stateDir) ? readdirSync(stateDir).filter((name) => name.includes(SESSION)) : [],
  };
  const dirty = summary.cleanup.sessionListed || summary.cleanup.pluginListed || summary.cleanup.stateFilesLeft.length > 0 || Boolean(summary.trackerKilledAtCleanup);
  summary.timingsMs.total = elapsed(started);
  if (!failure && summary.trackerError) failure = new Error('the tracker wrote an error file');
  if (!failure && dirty) failure = new Error('cleanup found the session, the plugin link, state files or a live tracker left behind');
  if (!failure && summary.timingsMs.total > 180000) failure = new Error('the run took longer than 3 minutes');
  summary.passed = !failure;
  if (failure) summary.error = failure.message;

  const needles = [[scratch, '<scratch>'], [homedir(), '<home>'], [homedir().replace(/\\/g, '/'), '<home>'], [process.env.USERNAME ?? '', '<user>']].filter(([n]) => n);
  const clean = (value) => {
    if (typeof value === 'string') return needles.reduce((text, [needle, label]) => text.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(label), value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  console.log(JSON.stringify(clean(summary), null, 2));
  process.exitCode = failure ? 1 : 0;
}
