import type { Logger } from "../herdr";
import { errorText } from "../log";
import type { RestoreManifest } from "./manifest";
import { defaultSocketName, isDefaultSessionSocket } from "./defaultSocket";
import { planSessionRepair } from "./planSessionRepair";
import type { RepairChange } from "./planSessionRepair";
import { parseManifest } from "./recorder";
import { parseSessionFile } from "./sessionFile";
import type { SessionPathResult } from "./sessionFile";
import type { ServerProbe } from "./serverProbe";

export const BACKUPS_KEPT = 5;
const BACKUP_PATTERN = /^session-.*\.json$/;

export interface RepairFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  rm(path: string): Promise<void>;
}

export interface RepairDeps {
  platform: NodeJS.Platform;
  /** Where herdr's default-session file lives, or why that is unknown (including the env overrides). */
  locate: () => SessionPathResult;
  /** The socket the extension's client uses (settings and env overrides applied). */
  socketName: () => string;
  /** One short connect attempt to the given socket. */
  probeServer: (socketName: string) => Promise<ServerProbe>;
  fs: RepairFs;
  manifestPath: string;
  backupDir: string;
  now: () => Date;
  log: Logger;
}

export type RepairOutcome = { kind: "repaired"; changes: RepairChange[] } | { kind: "left"; reason: string };

function describe({ workspaceId, paneId, from, to }: RepairChange): string {
  const target = paneId === null ? "identity_cwd" : `pane ${paneId}`;
  return `repaired: workspace ${workspaceId} ${target}: ${from} -> ${to}`;
}

// Colons are not valid in Windows file names.
function backupName(now: Date): string {
  return `session-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

async function backUp(deps: RepairDeps, sessionText: string): Promise<void> {
  const { fs, backupDir } = deps;
  await fs.mkdir(backupDir);
  await fs.writeFile(`${backupDir}/${backupName(deps.now())}`, sessionText);
  const backups = (await fs.readdir(backupDir)).filter((name) => BACKUP_PATTERN.test(name)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) await fs.rm(`${backupDir}/${old}`);
}

async function replaceFile(deps: RepairDeps, path: string, text: string): Promise<void> {
  const { fs } = deps;
  const temp = `${path}.navigator-repair.tmp`;
  try {
    await fs.writeFile(temp, text);
    await fs.rename(temp, path);
  } catch (err: unknown) {
    await fs.rm(temp).catch(() => undefined);
    throw err;
  }
}

async function run(deps: RepairDeps): Promise<RepairOutcome> {
  const { fs, platform } = deps;
  const located = deps.locate();
  if (located.kind === "unsupported") return { kind: "left", reason: located.reason };
  if (!isDefaultSessionSocket(located.path, deps.socketName(), platform)) return { kind: "left", reason: "socket override points at another server" };
  const server = await deps.probeServer(defaultSocketName(located.path, platform));
  if (server.state === "running") return { kind: "left", reason: "herdr server is running" };
  if (server.state === "unknown") return { kind: "left", reason: `herdr server state unknown (${server.detail})` };

  const manifest: RestoreManifest | undefined = parseManifest(await fs.readFile(deps.manifestPath).catch(() => ""));
  if (manifest === undefined) return { kind: "left", reason: "no usable restore manifest" };
  if (manifest.consumedAt !== undefined) return { kind: "left", reason: "restore manifest already applied" };

  const sessionText = await fs.readFile(located.path).catch(() => undefined);
  if (sessionText === undefined) return { kind: "left", reason: "session file unreadable" };
  const parsed = parseSessionFile(sessionText);
  if (!parsed.ok) return { kind: "left", reason: parsed.reason };

  const plan = planSessionRepair({ path: located.path, session: parsed.session }, manifest, platform, deps.now());
  if (plan.kind === "leave") return { kind: "left", reason: plan.reason };

  await backUp(deps, sessionText);
  await replaceFile(deps, located.path, JSON.stringify(plan.session, null, 2));
  // The file is already repaired; failing to mark the manifest must not turn that into a failure.
  await replaceFile(deps, deps.manifestPath, JSON.stringify({ ...manifest, consumedAt: deps.now().toISOString() })).catch((err: unknown) =>
    deps.log("warn", `restore repair: could not mark manifest applied: ${errorText(err)}`),
  );
  return { kind: "repaired", changes: plan.changes };
}

/**
 * Repairs herdr's session file from the restore manifest. Only meant to run while the herdr server
 * is down; every doubt or failure leaves the file alone and is logged.
 */
export async function repairSessionFolders(deps: RepairDeps): Promise<RepairOutcome> {
  let outcome: RepairOutcome;
  try {
    outcome = await run(deps);
  } catch (err: unknown) {
    outcome = { kind: "left", reason: errorText(err) };
  }
  if (outcome.kind === "left") deps.log("info", `restore repair: left alone: ${outcome.reason}`);
  else for (const change of outcome.changes) deps.log("info", `restore repair: ${describe(change)}`);
  return outcome;
}
