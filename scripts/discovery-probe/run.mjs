// Measures the discovery-popup unknowns in an isolated named herdr session (Windows). See README.md.
// Every herdr call names `--session navigator-discovery-probe`; nothing addresses the default session
// except the read-only `session list` / `plugin list` listings. The probe plugin is global while linked,
// so its hooks exit at once unless HERDR_SESSION is the probe session.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'navigator-discovery-probe';
const PLUGIN_ID = 'zenderx.discovery-probe';
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, 'plugin');
const herdrExe = process.env.HERDR_BIN_PATH || 'herdr';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-discovery-'));
const out = path.join(scratch, 'out');
const folderA = path.join(scratch, 'folder-a');
const folderB = path.join(scratch, 'folder-b');
for (const dir of [out, folderA, folderB]) mkdirSync(dir);
mkdirSync(path.join(folderA, '.vscode'));

// herdr refuses nested launches keyed on HERDR_*; TERM_PROGRAM is set explicitly because a herdr pane overwrites it.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
delete baseEnv.TERM_PROGRAM;
delete baseEnv.TERM_PROGRAM_VERSION;
delete baseEnv.VSCODE_INJECTION;
baseEnv.PROBE_OUT = out;
const plainEnv = { ...baseEnv };
const vscodeEnv = { ...baseEnv, TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.105.0', VSCODE_INJECTION: '1' };

const evidence = {};
const clients = [];
let stateDirs = new Set();

function exec(file, args, env = baseEnv) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 90000 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const herdr = (...args) => exec('herdr', ['--session', SESSION, ...args]);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  return undefined;
}
const outFiles = (prefix) => readdirSync(out).filter((name) => name.startsWith(prefix));

async function sessionInfo() {
  const { stdout } = await exec('herdr', ['session', 'list', '--json']);
  return json(stdout)?.sessions.find(({ name }) => name === SESSION);
}
const clientCount = async () => {
  const info = await sessionInfo();
  const log = info && path.join(info.session_dir, 'herdr-server.log');
  return log && existsSync(log) ? (readFileSync(log, 'utf8').match(/client connected/g) ?? []).length : 0;
};
async function serverLogLines(pattern) {
  const info = await sessionInfo();
  const log = info && path.join(info.session_dir, 'herdr-server.log');
  return log && existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter((line) => pattern.test(line)) : [];
}

// Reads and removes every hook/popup output file, keeping the arm and release control files.
function drain(label) {
  const files = {};
  for (const name of readdirSync(out)) {
    if (name.startsWith('arm-') || name === 'popup-release') continue;
    const file = path.join(out, name);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^HERDR_PLUGIN_STATE_DIR=(.+)$/gm)) stateDirs.add(match[1].trim());
    files[name.replace(/\d{9}/, '<time>')] = text.trim().split(/\r?\n/);
    rmSync(file);
  }
  evidence[label] = { ...evidence[label], files };
}
const arm = (event, entry, mode) => writeFileSync(path.join(out, `arm-${event}.txt`), `${entry} ${mode}`);
const disarm = (event) => rmSync(path.join(out, `arm-${event}.txt`), { force: true });

function rpc(socketPath, method, params) {
  return new Promise((resolve) => {
    let buffer = '';
    const sock = net.connect('\\\\.\\pipe\\' + socketPath.replace(/^\\\\\.\\pipe\\/, ''));
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'probe', method, params }) + '\n'));
    sock.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) { sock.end(); resolve(buffer.trim()); }
    });
    sock.on('error', (error) => resolve(`socket error: ${error.message}`));
    setTimeout(() => { sock.destroy(); resolve(`timeout; got: ${buffer}`); }, 10000);
  });
}

function startServer(env) {
  const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd: scratch, stdio: 'ignore', detached: true, env });
  server.unref();
  return waitFor(async () => (await sessionInfo())?.running, 30000);
}
async function startClient(env) {
  const script = `(Start-Process -FilePath '${herdrExe}' -ArgumentList '--session','${SESSION}' -WindowStyle Minimized -PassThru).Id`;
  const result = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], env);
  const pid = Number(result.stdout);
  if (Number.isInteger(pid)) clients.push(pid);
  return pid;
}
async function stopSession() {
  for (const pid of clients.splice(0)) await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
  await exec('herdr', ['session', 'stop', SESSION]);
  await sleep(1000);
  await exec('herdr', ['session', 'delete', SESSION]);
}
const createWorkspace = async (label, cwd) => json((await herdr('workspace', 'create', '--cwd', cwd, '--label', label)).stdout)?.result;

// Waits for a popup attempt log and, if the popup opened, its started marker; reports both.
async function expectPopup(label, { busyProbe = false } = {}) {
  const attempt = await waitFor(() => outFiles('popup-').some((n) => n.endsWith('.log')), 12000);
  const started = attempt && (await waitFor(() => outFiles('popup-started-').length > 0, 6000));
  evidence[label] = { attemptLogged: Boolean(attempt), popupProcessStarted: Boolean(started) };
  if (started && busyProbe) {
    const info = await sessionInfo();
    const cli = await herdr('plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'popup');
    const api = await rpc(info.socket_path, 'plugin.pane.open', { plugin_id: PLUGIN_ID, entrypoint: 'popup', placement: 'popup', width: 60, height: 8 });
    evidence[label].secondRequestWhileOpen = { cliManifestPopup: cli, apiPopupPlacement: api };
  }
  writeFileSync(path.join(out, 'popup-release'), '');
  await sleep(2500);
  rmSync(path.join(out, 'popup-release'), { force: true });
  await sleep(1500);
  drain(label);
}

async function watchWindows(label, seconds, action) {
  const file = path.join(scratch, `flash-${label}.json`);
  const watcher = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'flash-watch.ps1'), '-Seconds', String(seconds), '-Out', file], { env: baseEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => watcher.stdout.on('data', (chunk) => String(chunk).includes('ready') && resolve()));
  const done = new Promise((resolve) => watcher.on('exit', resolve));
  await action();
  await done;
  return json(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

async function main() {
  evidence.before = {
    sessions: (await exec('herdr', ['session', 'list', '--json'])).stdout,
    plugins: (await exec('herdr', ['plugin', 'list'])).stdout,
  };
  if (await sessionInfo()) throw new Error(`session ${SESSION} already exists`);
  evidence.link = await exec('herdr', ['plugin', 'link', pluginDir]);
  if (evidence.link.exit !== 0) throw new Error('plugin link failed');

  // A: server started without TERM_PROGRAM, no client attached.
  arm('startup', 'popup', 'cli');
  await startServer(plainEnv);
  await waitFor(() => outFiles('env-startup').length > 0);
  await expectPopup('A1 startup, no client, plain env, CLI placement flags');
  arm('workspace.created', 'popup-root', 'manifest');
  const wsA = await createWorkspace('probe-a', folderA);
  evidence.A2 = { workspaceCreate: wsA?.workspace };
  await waitFor(() => outFiles('env-workspace.created').length > 0);
  await expectPopup('A2 workspace.created, no client, plain env, popup-root manifest');
  await stopSession();
  disarm('workspace.created');

  // B: server started with TERM_PROGRAM=vscode.
  arm('startup', 'popup', 'manifest');
  await startServer(vscodeEnv);
  await waitFor(() => outFiles('env-startup').length > 0);
  await expectPopup('B1 startup, no client, vscode env, manifest popup');
  disarm('startup');
  const wsB = await createWorkspace('probe-b', folderA);
  await waitFor(() => outFiles('env-workspace.created').length > 0);
  drain('B2 workspace.created env, no client, vscode env');
  const before = await clientCount();
  await startClient(plainEnv);
  await waitFor(async () => (await clientCount()) > before, 30000);
  await sleep(3000);
  drain('B3 after client attach (a startup file here would mean startup re-ran)');

  const workspaceId = wsB.workspace.workspace_id;
  arm('tab.created', 'popup', 'cli');
  evidence.B4tab = await herdr('tab', 'create', '--workspace', workspaceId);
  await expectPopup('B4 tab.created, client attached, vscode env, CLI placement flags', { busyProbe: true });
  disarm('tab.created');

  arm('workspace.created', 'popup', 'manifest');
  await createWorkspace('probe-c', folderB);
  await expectPopup('B5 workspace.created, client attached, manifest popup (relative -File path)', { busyProbe: true });
  arm('workspace.created', 'popup-root', 'manifest');
  await createWorkspace('probe-d', folderB);
  await expectPopup('B6 workspace.created, client attached, manifest popup-root (-Command via HERDR_PLUGIN_ROOT)');
  disarm('workspace.created');

  const schema = (await exec('herdr', ['api', 'schema', '--json'])).stdout;
  evidence.modal = {
    cliPluginPaneOpenHelp: (await exec('herdr', ['plugin', 'pane', 'open', '--help'])).stdout.split(/\r?\n/).filter((l) => /placement|width|height|possible/.test(l)),
    schemaMethodsMatching: [...new Set([...schema.matchAll(/"const":\s*"([a-z_.]+)"/g)].map((m) => m[1]).filter((m) => /settings|copy|modal|popup|overlay/.test(m)))],
  };
  await stopSession();

  // C: client launched first starts the server itself (startup with a client), then the flash measurement.
  arm('startup', 'popup', 'manifest');
  await startClient(vscodeEnv);
  await waitFor(async () => (await clientCount()) > 0, 40000);
  await waitFor(() => outFiles('env-startup').length > 0, 30000);
  await sleep(2000);
  evidence.C1serverLog = await serverLogLines(/client connected|startup/i);
  await expectPopup('C1 startup with client launched first, vscode env, manifest popup');
  disarm('startup');
  const first = await createWorkspace('probe-e', folderA);
  const second = await createWorkspace('probe-f', folderB);
  await sleep(2000);
  drain('C2 workspace.created env JSON with a .vscode folder');
  const ids = [first.workspace.workspace_id, second.workspace.workspace_id];

  // The event JSON has no folder; time the calls a hook would make to get it.
  const timed = async (...args) => {
    const started = Date.now();
    const result = await herdr(...args);
    return { ms: Date.now() - started, exit: result.exit, stdout: result.stdout.slice(0, 900) };
  };
  evidence.folderLookup = { workspaceGet: await timed('workspace', 'get', ids[0]), paneList: await timed('pane', 'list', '--workspace', ids[0]) };

  evidence.flash = {
    positiveControl: await watchWindows('control', 8, async () => {
      await exec('powershell', ['-NoProfile', '-Command', "Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Milliseconds 1500'"]);
      await sleep(3500);
    }),
    idle: await watchWindows('idle', 6, () => sleep(5000)),
    switching: await watchWindows('switching', 16, async () => {
      for (let i = 0; i < 20; i += 1) {
        await herdr('workspace', 'focus', ids[i % 2]);
        await sleep(350);
      }
    }),
  };
  const log = (await herdr('plugin', 'log', 'list', '--plugin', PLUGIN_ID, '--limit', '200')).stdout;
  evidence.flash.focusHookLogEntries = (log.match(/workspace\.focused/g) ?? []).length;
  evidence.flash.logSample = log.slice(0, 600);
}

try {
  await main();
} finally {
  await stopSession().catch(() => undefined);
  const configDir = (await exec('herdr', ['plugin', 'config-dir', PLUGIN_ID])).stdout;
  evidence.unlink = await exec('herdr', ['plugin', 'unlink', PLUGIN_ID]);
  for (const dir of [...stateDirs, configDir]) if (dir && dir.includes(PLUGIN_ID)) rmSync(dir, { recursive: true, force: true });
  evidence.after = {
    sessions: (await exec('herdr', ['session', 'list', '--json'])).stdout,
    plugins: (await exec('herdr', ['plugin', 'list'])).stdout,
    removedDirs: [...stateDirs, configDir].filter((dir) => dir && existsSync(dir)),
  };
  const needles = [[scratch, '<scratch>'], [homedir(), '<home>'], [homedir().replace(/\\/g, '/'), '<home>'], [process.env.USERNAME ?? '', '<user>']].filter(([n]) => n);
  const clean = (value) => {
    if (typeof value === 'string') return needles.reduce((text, [needle, label]) => text.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(label), value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  console.log(JSON.stringify(clean(evidence), null, 2));
  rmSync(scratch, { recursive: true, force: true });
}
