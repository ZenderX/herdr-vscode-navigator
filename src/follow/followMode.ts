export const FOLLOW_MODES = ["folder", "workspace"] as const;
export type FollowMode = (typeof FOLLOW_MODES)[number];

// Workspace by default: folder mode reloads the window, which closes integrated terminals.
export const DEFAULT_FOLLOW_MODE: FollowMode = "workspace";

export function parseFollowMode(value: unknown): FollowMode {
  return FOLLOW_MODES.find((mode) => mode === value) ?? DEFAULT_FOLLOW_MODE;
}
