import * as path from "node:path";
import type { StatusBarItem } from "vscode";

export const TOGGLE_COMMAND = "herdrNavigator.toggleAutoFollow";
export const LAUNCH_COMMAND = "herdrNavigator.launchHerdr";

/** The slice of vscode.StatusBarItem this module touches. */
export type StatusBarItemLike = Pick<StatusBarItem, "text" | "tooltip" | "command" | "show" | "dispose">;

export class StatusBar {
  constructor(private readonly item: StatusBarItemLike) {
    this.update(false, false, null, false);
    this.item.show();
  }

  /** `hostsHerdr`: herdr runs in this window, so a click toggles auto-follow; otherwise it launches herdr. */
  update(connected: boolean, autoFollow: boolean, trackedPath: string | null, hostsHerdr: boolean, suppressedReason?: string): void {
    const label = connected ? (trackedPath ? path.basename(trackedPath) : "connected") : "disconnected";
    this.item.text = `$(terminal) herdr: ${label}${suppressedReason ? " (not following)" : ""}`;
    const auto = suppressedReason ?? (autoFollow ? "auto-follow on" : "auto-follow off");
    const click = hostsHerdr ? "click to toggle auto-follow" : "click to launch herdr";
    this.item.command = hostsHerdr ? TOGGLE_COMMAND : LAUNCH_COMMAND;
    this.item.tooltip = `${trackedPath ?? "no followed folder"}\n${auto} (${click})`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
