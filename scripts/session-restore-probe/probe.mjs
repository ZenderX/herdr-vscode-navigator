// Isolated probe of herdr's pane-id join. Runs only against the named session `navigator-probe`
// (headless `herdr --session navigator-probe server`), never the default session.
// Every mutating or scratch call passes `--session navigator-probe`, or names it as the positional argument of `herdr session stop|delete`;
// `herdr session list --json` is read-only and names no session. The HERDR_SESSION environment variable is NOT honoured by the CLI.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const SESSION = 'navigator-probe';
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function herdr(...args) {
  const { stdout } = await run('herdr', ['--session', SESSION, ...args]);
  return stdout.trim() === '' ? undefined : JSON.parse(stdout);
}

async function sessionInfo() {
  const { stdout } = await run('herdr', ['session', 'list', '--json']);
  return JSON.parse(stdout).sessions.find(({ name }) => name === SESSION);
}

async function waitFor(label, check, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'navigator-probe-'));
const folderA = path.join(scratch, 'a');
const folderB = path.join(scratch, 'b');
mkdirSync(folderA);
mkdirSync(folderB);
const placeholder = (text) => text.split(scratch).join('<scratch>');

const server = spawn('herdr', ['--session', SESSION, 'server'], { cwd: scratch, stdio: 'ignore', detached: true });
server.unref();

try {
  await waitFor('named server', async () => (await sessionInfo())?.running);
  const info = await sessionInfo();
  const sessionJson = path.join(info.session_dir, 'session.json');

  const created = await herdr('workspace', 'create', '--cwd', folderA, '--label', 'probe');
  const workspaceId = created.result.workspace.workspace_id;
  const rootPane = created.result.root_pane.pane_id;
  const split = await herdr('pane', 'split', rootPane, '--direction', 'right', '--cwd', folderB);
  const splitPane = split.result.pane.pane_id;
  await herdr('pane', 'send-text', splitPane, 'cd ..');
  await herdr('pane', 'send-keys', splitPane, 'Enter');
  await sleep(3000);

  const panes = (await herdr('pane', 'list')).result.panes.filter((pane) => pane.workspace_id === workspaceId);
  // herdr rewrites session.json on autosave; wait until the new workspace is in the file.
  const persisted = await waitFor('session.json to list the probe workspace', async () => {
    const file = JSON.parse(readFileSync(sessionJson, 'utf8'));
    return file.workspaces.find(({ id }) => id === workspaceId);
  }, 60);

  const join = panes.map((pane) => {
    const number = Number(/:p(\d+)$/.exec(pane.pane_id)[1]);
    const internal = Object.entries(persisted.public_pane_numbers).find(([, value]) => value === number)?.[0];
    const spawn = persisted.tabs.flatMap((tab) => Object.entries(tab.panes)).find(([key]) => key === internal)?.[1].cwd;
    return { livePane: pane.pane_id, publicNumber: number, internalId: internal ?? null, liveCwd: placeholder(pane.cwd), persistedSpawnCwd: spawn === undefined ? null : placeholder(spawn) };
  });

  console.log(JSON.stringify({
    sessionDir: placeholder(info.session_dir).replace(/^.*[\\/]sessions[\\/]/, '<config dir>/sessions/'),
    workspaceIdsMatch: persisted.id === workspaceId,
    joinHolds: join.every(({ internalId }) => internalId !== null),
    join,
  }, null, 2));
} finally {
  await run('herdr', ['session', 'stop', SESSION]).catch(() => undefined);
  await sleep(1000);
  await run('herdr', ['session', 'delete', SESSION]).catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
}
