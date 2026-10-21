// Isolated end-to-end check of the pre-launch repair. Needs `npm run compile` first (imports ../../out).
// The only call that addresses the default session is the read-only `herdr workspace list` (liveWorkspaceIds) before and after, to confirm it is untouched.
// Every other herdr call names `navigator-probe`, via --session or as the positional name of `session stop` / `session delete`; `session list` is read-only.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultSocketName } from '../../out/restore/defaultSocket.js';
import { buildManifest } from '../../out/restore/recorder.js';
import { repairSessionFolders } from '../../out/restore/repair.js';
import { parseSessionFile } from '../../out/restore/sessionFile.js';

const SESSION = 'navigator-probe';
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const platform = process.platform;

async function herdr(...args) {
  const { stdout } = await run('herdr', ['--session', SESSION, ...args]);
  return stdout.trim() === '' ? undefined : JSON.parse(stdout);
}

async function sessionInfo() {
  const { stdout } = await run('herdr', ['session', 'list', '--json']);
  return JSON.parse(stdout).sessions.find(({ name }) => name === SESSION);
}

async function liveWorkspaceIds() {
  const { stdout } = await run('herdr', ['workspace', 'list']);
  return JSON.parse(stdout).result.workspaces.map(({ workspace_id }) => workspace_id).sort().join(',');
}

async function waitFor(label, check, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startServer(cwd) {
  const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd, stdio: 'ignore', detached: true });
  server.unref();
}

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-e2e-'));
const store = path.join(scratch, 'store');
mkdirSync(store);
const folderA = path.join(scratch, 'repoA');
const folderB = path.join(scratch, 'repoB');
mkdirSync(folderA);
// folderB is a linked worktree of folderA, so a workspace moved there must stay grouped under repo A.
await run('git', ['init', '-q', folderA]);
await run('git', ['-C', folderA, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
await run('git', ['-C', folderA, 'worktree', 'add', '-q', folderB, '-b', 'probe-branch']);
// Anything not under the scratch folder (real paths, project names) never reaches stdout.
const placeholder = (text) => (String(text).includes(scratch) ? String(text).split(scratch).join('<scratch>') : '<other>');
const label = (text) => (text === 'repoA' || text === 'repoB' ? text : '<other>');

if (await sessionInfo()) {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`a ${SESSION} session already exists; stop and delete it first so the e2e starts clean`);
}
const liveBefore = await liveWorkspaceIds();
const report = { };
let sessionJson;
try {
  startServer(scratch);
  await waitFor('named server', async () => (await sessionInfo())?.running);
  const info = await sessionInfo();
  sessionJson = path.join(info.session_dir, 'session.json');

  // `worktree open` is what gives the workspace a worktree_space; plain `workspace create` does not.
  const created = await herdr('worktree', 'open', '--cwd', folderA, '--path', folderA);
  const workspaceId = created.result.workspace.workspace_id;
  const paneId = created.result.root_pane.pane_id;
  await sleep(1500);
  await herdr('pane', 'send-text', paneId, `cd "${folderB.replace(/\\/g, '/')}"`);
  await herdr('pane', 'send-keys', paneId, 'Enter');
  await waitFor('pane cwd to follow the cd', async () => {
    const pane = (await herdr('pane', 'list')).result.panes.find((p) => p.pane_id === paneId);
    return pane && path.resolve(pane.cwd) === path.resolve(folderB);
  });
  const persisted = await waitFor('session.json to list the workspace', async () => {
    const file = JSON.parse(readFileSync(sessionJson, 'utf8'));
    return file.workspaces.find(({ id }) => id === workspaceId);
  }, 80);
  report.fileBeforeStop = { identity_cwd: placeholder(persisted.identity_cwd), worktree_space: persisted.worktree_space ? placeholder(persisted.worktree_space.repo_root) : null };

  const panes = (await herdr('pane', 'list')).result.panes;
  const workspaces = (await herdr('workspace', 'list')).result.workspaces;
  const loaded = parseSessionFile(readFileSync(sessionJson, 'utf8'));
  if (!loaded.ok) throw new Error(loaded.reason);
  const snapshot = { focused_workspace_id: workspaceId, focused_tab_id: null, focused_pane_id: paneId, panes, tabs: [], workspaces };
  const { manifest } = buildManifest({ path: sessionJson, session: loaded.session }, snapshot, undefined, new Date(), platform, { focusedFolder: folderB });
  const manifestPath = path.join(store, 'restore-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  report.manifestWorkspace = manifest.workspaces.filter(({ id }) => id === workspaceId).map(({ label, folder, panes: ps }) => ({ label, folder: placeholder(folder), panes: ps.map((p) => ({ spawnCwd: placeholder(p.spawnCwd), liveCwd: placeholder(p.liveCwd) })) }));

  await run('herdr', ['session', 'stop', SESSION]);
  await waitFor('named server to stop', async () => !(await sessionInfo())?.running);
  const afterStop = JSON.parse(readFileSync(sessionJson, 'utf8')).workspaces.find(({ id }) => id === workspaceId);
  report.fileAfterStop = { identity_cwd: placeholder(afterStop.identity_cwd), paneCwds: Object.values(afterStop.tabs[0].panes).map((p) => placeholder(p.cwd)) };

  const logs = [];
  const outcome = await repairSessionFolders({
    platform,
    locate: () => ({ kind: 'path', path: sessionJson }),
    // The scratch session.json stands in for the default one; the socket check is answered by herdr's own session list.
    socketName: () => defaultSocketName(sessionJson, platform),
    probeServer: async () => ((await sessionInfo())?.running ? { state: 'running' } : { state: 'stopped' }),
    fs: {
      readFile: (p) => readFile(p, 'utf8'),
      writeFile: (p, text) => writeFile(p, text, 'utf8'),
      rename,
      mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
      readdir: (dir) => readdir(dir),
      rm: (p) => rm(p, { force: true }),
    },
    manifestPath,
    backupDir: path.join(store, 'backups'),
    now: () => new Date(),
    log: (_level, message) => logs.push(placeholder(message)),
  });
  report.outcome = outcome.kind;
  report.logs = logs;
  const repaired = JSON.parse(readFileSync(sessionJson, 'utf8')).workspaces.find(({ id }) => id === workspaceId);
  report.fileAfterRepair = { identity_cwd: placeholder(repaired.identity_cwd), paneCwds: Object.values(repaired.tabs[0].panes).map((p) => placeholder(p.cwd)), worktree_space: repaired.worktree_space ? 'present' : 'absent' };

  startServer(scratch);
  await waitFor('named server restart', async () => (await sessionInfo())?.running);
  await sleep(3000);
  const livePanes = (await herdr('pane', 'list')).result.panes;
  const liveWorkspaces = (await herdr('workspace', 'list')).result.workspaces;
  const restored = livePanes.find((pane) => path.resolve(pane.cwd) === path.resolve(folderB));
  report.restored = restored
    ? { paneCwd: placeholder(restored.cwd), label: label(liveWorkspaces.find(({ workspace_id }) => workspace_id === restored.workspace_id)?.label) }
    : { paneCwds: livePanes.map((pane) => placeholder(pane.cwd)) };
  // Wait one autosave (about a minute) to see what herdr writes for worktree_space.
  await sleep(70000);
  const rederived = JSON.parse(readFileSync(sessionJson, 'utf8')).workspaces.find((w) => path.resolve(w.identity_cwd) === path.resolve(folderB));
  report.liveWorktreeField = (await herdr('workspace', 'list')).result.workspaces.map((w) => (w.worktree ? placeholder(w.worktree.repo_root) : null));
  report.fileAfterRestart = rederived
    ? { identity_cwd: placeholder(rederived.identity_cwd), worktree_space: rederived.worktree_space ? placeholder(rederived.worktree_space.repo_root) : 'absent' }
    : 'no workspace for the live folder in the restarted file';
  report.liveListViaCli = liveWorkspaces.map((w) => ({ workspace_id: w.workspace_id, label: label(w.label), paneCwds: livePanes.filter((p) => p.workspace_id === w.workspace_id).map((p) => placeholder(p.cwd)) }));
} finally {
  await run('herdr', ['session', 'stop', SESSION]).catch(() => undefined);
  await sleep(1000);
  await run('herdr', ['session', 'delete', SESSION]).catch(() => undefined);
  // The server's cwd is the scratch folder; Windows may keep it locked briefly.
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.error(`could not remove scratch folder: ${err.code}`);
  }
}
report.defaultSessionUntouched = liveBefore === (await liveWorkspaceIds());
console.log(JSON.stringify(report, null, 2));
