export const MANIFEST_VERSION = 1;

export interface ManifestPane {
  internalId: string;
  publicNumber: number;
  spawnCwd: string;
  agentSessionId?: string;
  liveCwd: string;
  observedAt: string;
}

export interface ManifestWorkspace {
  id: string;
  label: string;
  folder: string;
  panes: ManifestPane[];
}

export interface RestoreManifest {
  manifestVersion: 1;
  sessionFilePath: string;
  observedAt: string;
  /** Set by the repair runner once the manifest was applied; a refreshed manifest does not carry it. */
  consumedAt?: string;
  workspaces: ManifestWorkspace[];
}
