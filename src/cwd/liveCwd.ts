import { createShellCwdProbe, normalizeForPlatform } from "./shellCwd";
import type { CwdSource, FailedAttempt, ProbeDeps, ProbeResult, ProbeSettings, ResolvedCwd } from "./types";

export interface PaneCwdFields {
  cwd?: string | null;
  foreground_cwd?: string | null;
}

/** Subset of HerdrClient the probe needs: the shell pid of a pane. */
export interface ShellPidSource {
  processInfo(paneId: string): Promise<{ shell_pid: number }>;
}

/**
 * Picks the target directory: probe (when enabled and successful) > foreground_cwd > cwd.
 * `probe` is undefined when no probe ran; the reason is then taken from `settings.enabled`.
 */
export function resolveCwd(
  pane: PaneCwdFields,
  probe: ProbeResult | undefined,
  settings: Pick<ProbeSettings, "enabled">,
  platform: NodeJS.Platform,
): ResolvedCwd {
  const attempts: FailedAttempt[] = [];
  const win = (source: CwdSource, path: string): ResolvedCwd => ({ path, source, attempts });

  if (!settings.enabled) attempts.push({ source: "probe", reason: "disabled" });
  else if (!probe) attempts.push({ source: "probe", reason: "not run" });
  else if (probe.ok) return win("probe", probe.path);
  else attempts.push({ source: "probe", reason: probe.reason });

  const fields: ["foreground_cwd" | "cwd", string | null | undefined][] = [
    ["foreground_cwd", pane.foreground_cwd],
    ["cwd", pane.cwd],
  ];
  for (const [source, raw] of fields) {
    const path = normalizeForPlatform(raw, platform);
    if (path !== null) return win(source, path);
    attempts.push({ source, reason: raw ? `not an absolute path: ${raw}` : "absent" });
  }
  return { path: null, source: null, attempts };
}

export interface LiveCwdProbe {
  /** Never rejects; concurrent calls for one pane share a single in-flight probe. */
  probe(paneId: string, settings: ProbeSettings): Promise<ProbeResult>;
}

export function createLiveCwdProbe(client: ShellPidSource, deps: ProbeDeps): LiveCwdProbe {
  const probeShell = createShellCwdProbe(deps);
  const inflight = new Map<string, Promise<ProbeResult>>();

  const run = async (paneId: string, settings: ProbeSettings): Promise<ProbeResult> => {
    try {
      const { shell_pid } = await client.processInfo(paneId);
      return await probeShell(shell_pid, settings.gitBashPath);
    } catch (error: unknown) {
      return { ok: false, reason: `pane.process_info failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  return {
    probe(paneId, settings) {
      const existing = inflight.get(paneId);
      if (existing) return existing;
      const started = run(paneId, settings).finally(() => inflight.delete(paneId));
      inflight.set(paneId, started);
      return started;
    },
  };
}
