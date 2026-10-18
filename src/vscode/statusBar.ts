import * as path from "node:path";
import * as vscode from "vscode";

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

  constructor() {
    this.item.command = "herdrNavigator.toggleAutoFollow";
    this.update(false, false, null);
    this.item.show();
  }

  update(connected: boolean, autoFollow: boolean, trackedPath: string | null, suppressedReason?: string): void {
    const label = connected ? (trackedPath ? path.basename(trackedPath) : "connected") : "disconnected";
    this.item.text = `$(terminal) herdr: ${label}${suppressedReason ? " (not following)" : ""}`;
    const auto = suppressedReason ?? (autoFollow ? "auto-follow on" : "auto-follow off");
    this.item.tooltip = `${trackedPath ?? "no followed folder"}\n${auto} (click to toggle)`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
