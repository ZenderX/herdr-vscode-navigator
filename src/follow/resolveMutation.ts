import { samePath } from "../paths";
import type { FolderPlan } from "./planFolders";

export type Mutation = { start: number; deleteCount: number; add: string[] };

/** Maps a plan to its updateWorkspaceFolders arguments, or null when an add path is already open outside the range being deleted. */
export function resolveMutation(plan: Exclude<FolderPlan, { kind: "noop" }>, openPaths: readonly string[], platform: NodeJS.Platform): Mutation | null {
  let mutation: Mutation;
  switch (plan.kind) {
    case "convert":
      return { start: plan.start, deleteCount: plan.deleteCount, add: plan.add };
    case "replace":
      mutation = { start: plan.index, deleteCount: 1, add: plan.add };
      break;
    case "reclaim":
      mutation = { start: plan.index, deleteCount: plan.deleteCount, add: plan.add };
      break;
    case "append":
      mutation = { start: plan.index, deleteCount: 0, add: plan.add };
      break;
    case "remove":
      return { start: plan.index, deleteCount: 1, add: [] };
  }
  const { start, deleteCount, add } = mutation;
  // Folders inside the deleted range are removed by this same call, so re-adding one of them is legal and wanted.
  const kept = openPaths.filter((_, i) => i < start || i >= start + deleteCount);
  const present = add.some((p) => kept.some((open) => samePath(open, p, platform)));
  return present ? null : mutation;
}
