// Live measurement of herdr's `pane_updated` push after a cwd change (Windows), in the scratch session
// `navigator-listen-probe` only, with no shell configuration. Every herdr call names `--session`, except the read-only
// `session list`. The server reads a scratch config via HERDR_CONFIG_PATH and a scratch HOME, so no user file is read or edited.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const SESSION = 'navigator-listen-probe';
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PWSH = 'C:/Program Files (x86)/PowerShell/7/pwsh.exe';
const PIPE_PREFIX = '\\\\.\\pipe\\';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-listen-'));
// Mixed case on disk; panes are spawned with a lower-cased path to show which case herdr reports.
const spawnDir = path.join(scratch, 'Spawn Dir');
const dirs = { s: path.join(spawnDir, 'cd s'), t: path.join(spawnDir, 'cd t'), c: path.join(spawnDir, 'cd c'), a: path.join(spawnDir, 'Cd A'), ps7: path.join(spawnDir, 'ps 7') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const configPath = path.join(scratch, 'config.toml');
// Title-less, no OSC 7 (like starship or a custom PS1); the stock-prompt pane gets an empty HOME, so Git's own PS1 applies.
const home = path.join(scratch, 'home');
const stockHome = path.join(scratch, 'stock home');
mkdirSync(home);
mkdirSync(stockHome);
writeFileSync(path.join(home, '.bashrc'), "PS1='$ '\nunset PROMPT_COMMAND\n");
const fwd = (p) => p.replace(/\\/g, '/');
const writeConfig = (shell, nonLogin) => writeFileSync(configPath,
  `onboarding = false\n\n[terminal]\ndefault_shell = "${shell}"\n${nonLogin ? 'shell_mode = "non_login"\n' : ''}`);
writeConfig(GIT_BASH, true);

// herdr refuses nested launches keyed on HERDR_*, and an exported PS1 or PROMPT_COMMAND would survive into the panes;
// the config override is the only HERDR_* variable passed on.
const dropped = new Set(['PS1', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV', 'HOME']);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('HERDR_') && !dropped.has(key.toUpperCase()))),
  HOME: home,
  HERDR_CONFIG_PATH: configPath,
};

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const herdr = (...args) => exec('herdr', ['--session', SESSION, ...args]);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
async function herdrOk(...args) {
  const result = await herdr(...args);
  if (result.exit !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return json(result.stdout)?.result;
}

async function waitFor(label, check, ms, stepMs = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}`);
}

async function sessionInfo() {
  return json((await exec('herdr', ['session', 'list', '--json'])).stdout)?.sessions.find(({ name }) => name === SESSION);
}
const norm = (folder) => folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const isSpawnForm = (cwd) => cwd.length > 3 && /[\\/]$/.test(cwd);
const panes = async () => (await herdrOk('pane', 'list'))?.panes ?? [];
const pane = async (id) => (await panes()).find(({ pane_id }) => pane_id === id);
const quote = (p) => `'${fwd(p).replace(/'/g, "'\\''")}'`;
const psQuote = (p) => `'${p.replace(/'/g, "''")}'`;
// Git's stock title is "<MSYSTEM>:<MSYS path>", so a cd shows as the title's last path segment.
const titleEnds = (e, dir) => (e.pane.terminal_title_stripped ?? '').endsWith(`/${path.basename(dir)}`);

function startServer() {
  const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd: scratch, stdio: 'ignore', detached: true, env });
  server.unref();
  return waitFor('server running', async () => (await sessionInfo())?.running, 30000, 250);
}

// One events.subscribe connection; every pushed event is kept with its arrival time.
async function listen(socketPath) {
  const state = { events: [], closedAt: undefined };
  const sock = net.connect(socketPath.startsWith(PIPE_PREFIX) ? socketPath : PIPE_PREFIX + socketPath);
  state.sock = sock;
  sock.setEncoding('utf8');
  let buffer = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no subscription_started within 5000 ms')), 5000);
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id: 'listen', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.updated' }, { type: 'pane.created' }] } })}\n`);
    });
    sock.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const message = json(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        if (!message) continue;
        if (message.result?.type === 'subscription_started') {
          clearTimeout(timer);
          resolve();
        } else if (message.error) {
          reject(new Error(`events.subscribe failed: ${JSON.stringify(message.error)}`));
        } else if (message.event) {
          state.events.push({ at: Date.now(), event: message.event, pane: message.data?.pane ?? {} });
        }
      }
    });
    sock.on('error', (error) => { state.error = error.message; reject(error); });
    sock.on('close', () => { state.closedAt = Date.now(); });
  });
  return state;
}
const updates = (state, paneId, since) => state.events.filter((e) => e.event === 'pane_updated' && e.pane.pane_id === paneId && e.at >= since);
// Quotes a value for the table without JSON escaping, so the path scrubbing below still matches.
const q = (value) => (value == null ? String(value) : `"${value}"`);
const brief = (e) => ({ cwd: e.pane.cwd, title: e.pane.terminal_title_stripped ?? null });

async function createPane(cwd, label, ...extra) {
  const result = await herdrOk('workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus', ...extra);
  if (!result) throw new Error(`workspace create ${label} returned no result`);
  return { workspace: result.workspace.workspace_id, pane: result.root_pane.pane_id, createdCwd: result.root_pane.cwd };
}
async function runIn(paneId, command) {
  const at = Date.now();
  await herdrOk('pane', 'run', paneId, command);
  return { at, returnedAt: Date.now() };
}
const live = async (paneId) => {
  const cwd = (await pane(paneId))?.cwd;
  return cwd && !isSpawnForm(cwd) ? cwd : undefined;
};

const rows = [];
const row = (id, measurement, result) => rows.push({ id, measurement, result });
const detail = { date: new Date().toISOString(), session: SESSION, herdr: undefined };

async function main() {
  if (process.platform !== 'win32') throw new Error('this probe measures Windows ConPTY panes and runs on Windows only');
  if (await sessionInfo()) throw new Error(`session ${SESSION} already exists`);
  detail.herdr = (await exec('herdr', ['--version'])).stdout;
  const lowerSpawn = spawnDir.replace(/Spawn Dir$/, 'spawn dir');

  await startServer();
  detail.sessionDir = (await sessionInfo()).session_dir;
  let socket = await listen((await sessionInfo()).socket_path);

  // (5) the creation push of a title-less Git Bash pane, and its pane list cwd 3 s later.
  const createAt = Date.now();
  const t = await createPane(lowerSpawn, 'titleless-prompt');
  const created = await waitFor('pane_created for T', () => socket.events.find((e) => e.event === 'pane_created' && e.pane.pane_id === t.pane), 5000, 10);
  await sleep(3000);
  const tLater = await pane(t.pane);
  detail.created = { createResponseCwd: t.createdCwd, pushedCwd: created.pane.cwd, pushMs: created.at - createAt, paneListCwdAfter3s: tLater?.cwd, titleAfter3s: tLater?.terminal_title_stripped ?? null };
  row(5, 'pane_created cwd form, and pane list cwd 3 s later (title-less Git Bash)',
    `pushed after ${created.at - createAt} ms with cwd ${q(created.pane.cwd)} (${isSpawnForm(created.pane.cwd) ? 'spawn form' : 'live form'}); after 3 s pane list cwd ${q(tLater?.cwd)}, title ${q(detail.created.titleAfter3s)}`);

  // (1) Git for Windows' stock PS1 (title = $TITLEPREFIX:$PWD): a cd pushes the title, not a folder.
  const s = await createPane(lowerSpawn, 'stock-prompt', '--env', `HOME=${stockHome}`);
  await waitFor('stock PS1 title in S', async () => /^(MINGW|MSYS|UCRT|CLANG)\w*:/.test((await pane(s.pane))?.terminal_title_stripped ?? ''), 15000, 50);
  await sleep(1000);
  const sCd = await runIn(s.pane, `cd ${quote(dirs.s)}`);
  const sUpdate = await waitFor('pane_updated with the cd s title', () => updates(socket, s.pane, sCd.at).find((e) => titleEnds(e, dirs.s)), 5000, 5).catch(() => undefined);
  detail.stockCd = { matching: sUpdate && { ...brief(sUpdate), msFromRunStart: sUpdate.at - sCd.at, msFromRunReturn: sUpdate.at - sCd.returnedAt } };
  row(1, 'cd in Git Bash with the stock PS1 (no shell configuration)',
    sUpdate ? `pane_updated ${sUpdate.at - sCd.at} ms after \`pane run\` started (${sUpdate.at - sCd.returnedAt} ms after it returned); cwd ${q(sUpdate.pane.cwd)} (${isSpawnForm(sUpdate.pane.cwd ?? '') ? 'spawn form' : 'live form'}), title ${q(sUpdate.pane.terminal_title_stripped)}` : 'no pane_updated with the new title within 5 s');
  if (!sUpdate) throw new Error('row 1: the stock prompt pushed no title for the cd');

  // (1t) the title-less PS1: a cd fires no event at all.
  const tCd = await runIn(t.pane, `cd ${quote(dirs.t)}`);
  await sleep(5000);
  const tPushes = updates(socket, t.pane, tCd.at);
  detail.titlelessCd = { pushes: tPushes.map(brief), paneListCwd: (await pane(t.pane))?.cwd };
  row('1t', 'cd in Git Bash with a title-less PS1 (no shell configuration)',
    `${tPushes.length} pane_updated within 5 s; pane list cwd ${q(detail.titlelessCd.paneListCwd)}`);
  if (tPushes.length) throw new Error(`row 1t: the title-less prompt pushed ${tPushes.length} pane_updated for a cd`);

  // (2) idle and a command without cd: neither prompt may change the title.
  const idleAt = Date.now();
  await sleep(20000);
  const idle = socket.events.filter((e) => e.event === 'pane_updated' && e.at >= idleAt);
  const sCmd = await runIn(s.pane, 'echo probe; ls >/dev/null');
  const tCmd = await runIn(t.pane, 'echo probe; ls >/dev/null');
  await sleep(3000);
  const sCmdPushes = updates(socket, s.pane, sCmd.at);
  const tCmdPushes = updates(socket, t.pane, tCmd.at);
  detail.idle = { idle: idle.map((e) => ({ pane: e.pane.pane_id, ...brief(e) })), stockCommand: sCmdPushes.map(brief), titlelessCommand: tCmdPushes.map(brief) };
  row(2, 'pane_updated pushes: 20 s idle (S+T) / short command, no cd, in S (stock PS1) and T (title-less PS1)',
    `${idle.length} during idle / S ${sCmdPushes.length}, T ${tCmdPushes.length} in 3 s after \`echo probe; ls\``);

  // Restore needs both workspaces in session.json (autosave lags a change by ~10 s).
  const sessionJson = path.join(detail.sessionDir, 'session.json');
  await waitFor('autosave of both workspaces', () => {
    const saved = existsSync(sessionJson) ? json(readFileSync(sessionJson, 'utf8')) : undefined;
    return [t.workspace, s.workspace].every((id) => saved?.workspaces?.some((ws) => ws.id === id));
  }, 30000, 500);

  // (3) a stock-prompt cd, then session stop ~1 s later.
  const stopCd = await runIn(s.pane, `cd ${quote(dirs.c)}`);
  await sleep(1000 - (Date.now() - stopCd.at));
  const stopAt = Date.now();
  await exec('herdr', ['session', 'stop', SESSION]);
  await waitFor('server stopped', async () => !(await sessionInfo())?.running, 15000, 250);
  const beforeStop = updates(socket, s.pane, stopCd.at).find((e) => titleEnds(e, dirs.c));
  detail.stop = { stopAfterCdMs: stopAt - stopCd.at, delivered: beforeStop && { ...brief(beforeStop), ms: beforeStop.at - stopCd.at }, socketClosedMs: socket.closedAt && socket.closedAt - stopCd.at };
  row(3, 'stock-prompt cd then `session stop` ~1 s later',
    `${beforeStop ? `title push delivered ${beforeStop.at - stopCd.at} ms after the cd` : 'not delivered'}; stop issued at +${stopAt - stopCd.at} ms, socket closed at +${socket.closedAt ? socket.closedAt - stopCd.at : 'never'} ms`);
  socket.sock.destroy();

  // (4) restored readings: with no OSC 7 a Git Bash pane's cwd stays the spawn form.
  const restartAt = Date.now();
  await startServer();
  socket = await listen((await sessionInfo()).socket_path);
  const readings = { [t.pane]: [], [s.pane]: [] };
  const watchUntil = Date.now() + 8000;
  while (Date.now() < watchUntil) {
    const list = await panes();
    for (const id of [t.pane, s.pane]) {
      const cwd = list.find(({ pane_id }) => pane_id === id)?.cwd;
      if (cwd && readings[id].at(-1)?.cwd !== cwd) readings[id].push({ ms: Date.now() - restartAt, cwd });
    }
    await sleep(100);
  }
  detail.restore = { readings, restoreCreatedPushes: socket.events.filter((e) => e.event === 'pane_created').length };
  const sFirst = readings[s.pane][0];
  row(4, 'restored pane S: `pane list` readings for 8 s after the server start',
    `${sFirst ? `${q(sFirst.cwd)} (trailing \\: ${isSpawnForm(sFirst.cwd) ? 'yes' : 'no'}; case ${sFirst.cwd.includes('Spawn Dir') ? 'on-disk "Spawn Dir"' : 'as spawned "spawn dir"'}; first seen +${sFirst.ms} ms)` : 'no reading observed'}; ${readings[s.pane].length} distinct reading(s), T ${readings[t.pane].length}; pane_created pushes on restore: ${detail.restore.restoreCreatedPushes}`);

  // (6) a herdr-spawned PowerShell pane: herdr's own wrapper (OSC 9;9) reports its folder.
  writeConfig(POWERSHELL, false);
  await herdrOk('server', 'reload-config');
  const p = await createPowerShellPane('powershell', /powershell/i);
  const pCd = await runIn(p.pane, `cd '${fwd(dirs.a)}'`);
  await sleep(5000);
  const pUpdates = updates(socket, p.pane, pCd.at);
  const pAfter = await pane(p.pane);
  detail.powershell = { ...p.info, updates: pUpdates.map(brief), paneListCwd: pAfter?.cwd, title: pAfter?.terminal_title_stripped ?? null };
  row(6, 'cd in a herdr-spawned PowerShell pane',
    `${pUpdates.length ? `${pUpdates.length} pane_updated (first after ${pUpdates[0].at - pCd.at} ms, cwd ${q(pUpdates[0].pane.cwd)})` : 'no pane_updated within 5 s'}; pane list cwd after: ${q(pAfter?.cwd)}; title ${q(detail.powershell.title)}; title at first prompt ${q(p.info.titleAtPrompt)}`);

  // (6w) the host API instead of an escape sequence: does a RawUI title cross ConPTY into herdr's terminal_title?
  const rawTitle = 'navigator-rawui-title';
  const rawAt = (await runIn(p.pane, `$Host.UI.RawUI.WindowTitle = '${rawTitle}'`)).at;
  const rawHit = await waitFor('RawUI title push', () => updates(socket, p.pane, rawAt).find((e) => e.pane.terminal_title_stripped === rawTitle), 5000, 5).catch(() => undefined);
  detail.rawUiTitle = { pushed: Boolean(rawHit), ms: rawHit && rawHit.at - rawAt, title: (await pane(p.pane))?.terminal_title_stripped ?? null };
  row('6w', 'PowerShell 5.1: `$Host.UI.RawUI.WindowTitle = ...`',
    rawHit ? `pane_updated with that title after ${rawHit.at - rawAt} ms` : `no pane_updated with that title within 5 s (title ${q(detail.rawUiTitle.title)})`);

  // (9) fact: herdr's wrapper syncs [Environment]::CurrentDirectory each prompt, so process-info should follow the live folder.
  writeConfig(PWSH, false);
  await herdrOk('server', 'reload-config');
  const w = await createPowerShellPane('pwsh', /pwsh/i);
  await runIn(w.pane, `Set-Location ${psQuote(dirs.ps7)}`);
  await waitFor('pwsh pane list cwd in ps 7', async () => norm((await pane(w.pane))?.cwd ?? '') === norm(dirs.ps7), 10000).catch(() => undefined);
  const info = (await herdrOk('pane', 'process-info', '--pane', w.pane))?.process_info;
  detail.processInfoAfterSetLocation = { foreground: info?.foreground_processes?.map(({ argv0, cwd }) => ({ argv0, cwd })), paneListCwd: (await pane(w.pane))?.cwd };
  const fgCwd = info?.foreground_processes?.[0]?.cwd;
  row(9, 'pwsh 7: `process-info` foreground_processes[0].cwd after Set-Location',
    `${q(fgCwd)} (${fgCwd && norm(fgCwd) === norm(dirs.ps7) ? 'follows the live folder' : fgCwd && norm(fgCwd) === norm(spawnDir) ? 'still the spawn folder' : 'neither the live nor the spawn folder'})`);
  socket.sock.destroy();

  // A herdr-spawned PowerShell pane at its first live prompt; herdr's wrapper (OSC 9;9) turns it live.
  async function createPowerShellPane(label, shell) {
    const createdAt = Date.now();
    const result = await createPane(spawnDir, label);
    // A just-spawned pane can report no foreground process yet.
    const argv0 = await waitFor(`${label} process info`, async () => (await herdrOk('pane', 'process-info', '--pane', result.pane))?.process_info?.foreground_processes?.[0]?.argv0, 10000, 250);
    if (!shell.test(argv0)) throw new Error(`pane ${result.pane} runs ${JSON.stringify(argv0)}, not ${label}; reload-config did not switch the shell`);
    // A PowerShell prompt that reports no cwd never turns live; then a fixed wait stands in for the prompt.
    const promptLive = Boolean(await waitFor(`first ${label} prompt`, () => live(result.pane), 20000).catch(() => undefined));
    const titleAtPrompt = (await pane(result.pane))?.terminal_title_stripped ?? null;
    await sleep(promptLive ? 1500 : 0);
    return { ...result, info: { argv0, promptLive, titleAtPrompt, startupTitles: updates(socket, result.pane, createdAt).map(brief) } };
  }
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
}
await exec('herdr', ['session', 'stop', SESSION]);
await sleep(1000);
await exec('herdr', ['session', 'delete', SESSION]);
const sessionDir = detail.sessionDir ?? path.join(process.env.APPDATA ?? '', 'herdr', 'sessions', SESSION);
// Only the scratch session's own dir is ever removed here.
if (path.basename(sessionDir) === SESSION && existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
const cleanup = { sessionListed: Boolean(await sessionInfo()), sessionDirLeft: existsSync(sessionDir) };
if (!failure && (cleanup.sessionListed || cleanup.sessionDirLeft)) failure = new Error('cleanup left the scratch session or its state dir behind');

const needles = [[scratch, '<scratch>'], [fwd(scratch), '<scratch>'], [homedir(), '<home>'], [fwd(homedir()), '<home>'], [process.env.USERNAME ?? '', '<user>']].filter(([n]) => n);
const clean = (value) => {
  if (typeof value === 'string') return needles.reduce((text, [needle, label]) => text.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(label), value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
  return value;
};
console.log(`${detail.herdr ?? 'herdr'}, session ${SESSION}, ${detail.date}`);
console.log('| # | measurement | result |\n|---|---|---|');
for (const { id, measurement, result } of clean(rows)) console.log(`| ${id} | ${measurement} | ${result} |`);
console.log(JSON.stringify(clean({ detail, cleanup, error: failure?.message }), null, 2));
process.exitCode = failure ? 1 : 0;
