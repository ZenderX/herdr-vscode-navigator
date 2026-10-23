import * as path from "node:path";
import type { StatusBarItem, ThemeColor } from "vscode";

export const TOGGLE_COMMAND = "herdrNavigator.toggleAutoFollow";
export const LAUNCH_COMMAND = "herdrNavigator.launchHerdr";
export const INSTALL_COMMAND = "herdrNavigator.openHerdrInstall";

// Left-aligned; no integer lies between the two, so no default- or integer-priority item can land between them.
export const MAIN_ITEM_PRIORITY = 0.75;
export const PLUGIN_HINT_PRIORITY = 0.25;

/** The slice of vscode.StatusBarItem this module touches. */
export type StatusBarItemLike = Pick<StatusBarItem, "text" | "tooltip" | "command" | "color" | "show" | "dispose">;

export class StatusBar {
  /** `themeColor` builds a vscode.ThemeColor; injected so this module loads without the vscode module. */
  constructor(private readonly item: StatusBarItemLike, private readonly themeColor: (id: string) => ThemeColor) {
    this.update(false, false, null, false);
    this.item.show();
  }

  /** `hostsHerdr`: herdr runs in this window, so a click toggles auto-follow; otherwise it launches herdr. */
  update(connected: boolean, autoFollow: boolean, trackedPath: string | null, hostsHerdr: boolean, suppressedReason?: string, herdrInstalled = true): void {
    // The icon shape carries the state (readable in high-contrast themes); the muted colour is secondary.
    const icon = autoFollow ? "$(eye)" : "$(eye-closed)";
    this.item.color = autoFollow ? undefined : this.themeColor("disabledForeground");
    if (!herdrInstalled) {
      this.item.text = `${icon} herdr: not installed`;
      this.item.command = INSTALL_COMMAND;
      this.item.tooltip = "herdr is not installed (click to open the install page)";
      return;
    }
    const label = connected ? (trackedPath ? path.basename(trackedPath) : "connected") : "disconnected";
    this.item.text = `${icon} herdr: ${label}${suppressedReason ? " (not following)" : ""}`;
    const auto = suppressedReason ?? (autoFollow ? "auto-follow on" : "auto-follow off");
    const click = hostsHerdr ? "click to toggle auto-follow" : "click to launch herdr";
    this.item.command = hostsHerdr ? TOGGLE_COMMAND : LAUNCH_COMMAND;
    this.item.tooltip = `${trackedPath ?? "no followed folder"}\n${auto} (${click})`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
