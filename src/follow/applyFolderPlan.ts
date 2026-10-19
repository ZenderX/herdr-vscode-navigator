import type { Logger } from "../herdr";
import { samePath } from "../paths";
import type { FolderPlan } from "./planFolders";
import { resolveMutation } from "./resolveMutation";

/** The workspace operations a plan can end in; the adapter binds them to VS Code. */
export interface PlanEffects {
  openFolders: () => string[];
  /** Writes the saved navigator workspace and reopens the window on it (a reload). */
  convert: (anchorPath: string, target: string) => Promise<boolean>;
  /** The in-place index edit; never reloads. */
  updateFolders: (kind: string, start: number, deleteCount: number, add: string[]) => Promise<boolean>;
}

export interface HostingHandoff {
  hostsHerdr: () => boolean;
  /** Must complete before the conversion starts: the reload ends the extension host. */
  beginHostingConversion: (folder: string) => Promise<void>;
  /** For a window that does not host herdr; must also complete before the conversion starts. */
  recordTakeover: (folder: string) => Promise<void>;
}

export interface PendingTakeover {
  folder?: string;
  /** When the takeover was recorded. */
  at: number;
}

/**
 * Puts a fresh pending takeover folder into slot 1 of a saved navigator, leaving index 0 and slots from 2 on alone, and never reloads.
 * Resolves the folder now in slot 1, or undefined when nothing was pending, it is stale, or the change was not made.
 */
export async function applyPendingTakeover(
  pending: PendingTakeover,
  now: number,
  maxAgeMs: number,
  effects: Pick<PlanEffects, "openFolders" | "updateFolders">,
  platform: NodeJS.Platform,
  log: Logger,
): Promise<string | undefined> {
  const { folder, at } = pending;
  if (folder === undefined || now - at > maxAgeMs) return undefined;
  const existing = effects.openFolders();
  if (existing.length === 0) return undefined;
  if (existing.length > 1 && samePath(existing[1], folder, platform)) {
    log("info", `plan: noop (takeover folder already in slot 1: ${folder})`);
    return folder;
  }
  const plan: FolderPlan = existing.length > 1 ? { kind: "replace", index: 1, add: [folder] } : { kind: "append", index: 1, add: [folder] };
  const mutation = resolveMutation(plan, existing, platform);
  if (mutation === null) {
    log("info", `mutation: takeover folder already open outside slot 1, nothing to do: ${folder}`);
    return undefined;
  }
  const applied = await effects.updateFolders(plan.kind, mutation.start, mutation.deleteCount, mutation.add);
  return applied ? folder : undefined;
}

export interface NavigatorActivation {
  takeover: PendingTakeover;
  /** Only a saved navigator is reopened untouched and needs the takeover applied. */
  savedNavigator: boolean;
  pendingTarget?: string;
  savedSlot?: string;
  now: number;
  maxAgeMs: number;
  /** Receives the slot to track, once it is open. */
  resume: (slot: string) => Promise<void>;
}

/**
 * Activation of a navigator window: moves a fresh takeover folder into slot 1, then resumes the tracked slot.
 * The takeover record is left for auto-launch, which consumes it after deciding where herdr launches.
 */
export async function activateNavigator(
  input: NavigatorActivation,
  effects: Pick<PlanEffects, "openFolders" | "updateFolders">,
  platform: NodeJS.Platform,
  log: Logger,
): Promise<void> {
  const { takeover, pendingTarget, savedSlot, now, maxAgeMs } = input;
  if (input.savedNavigator) await applyPendingTakeover(takeover, now, maxAgeMs, effects, platform, log);
  // A takeover or migration leaves the new saved workspace without a tracked slot, so its recorded folder takes the slot.
  const isOpen = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && effects.openFolders().slice(1).some((path) => samePath(path, candidate, platform));
  const resumed = [pendingTarget, takeover.folder, savedSlot].find(isOpen);
  if (resumed) await input.resume(resumed);
}

/** Applies one plan; resolves true once the change is made (or false if it was rejected). */
export async function applyFolderPlan(
  plan: FolderPlan,
  effects: PlanEffects,
  handoff: HostingHandoff,
  platform: NodeJS.Platform,
  log: Logger,
): Promise<boolean> {
  if (plan.kind === "noop") return true;

  const existing = effects.openFolders();
  const mutation = resolveMutation(plan, existing, platform);
  if (mutation === null) {
    log("info", `mutation: already present, nothing to do: ${plan.kind === "remove" ? "" : plan.add.join(", ")}`);
    // A skipped reclaim must not end adoption, so the caller must not record a tracked slot.
    return plan.kind !== "reclaim";
  }
  const { start, deleteCount, add } = mutation;

  if (plan.kind !== "convert") return effects.updateFolders(plan.kind, start, deleteCount, add);

  const target = add[add.length - 1];
  // A kept navigator file is reopened as stored, so every conversion records its folder; only a hosting window also has herdr relaunched there.
  if (handoff.hostsHerdr()) await handoff.beginHostingConversion(target);
  else await handoff.recordTakeover(target);
  return effects.convert(start === 0 ? add[0] : existing[0], target);
}
