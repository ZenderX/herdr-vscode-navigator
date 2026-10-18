import * as vscode from "vscode";
import type { CwdSource } from "../follow";
import { parseFollowMode, type FollowMode } from "./followMode";

export interface Settings {
  autoFollow: boolean;
  socketPath: string;
  cwdSource: CwdSource;
  debounceMs: number;
  cwdPollMs: number;
  liveCwdProbe: boolean;
  gitBashPath: string;
  followMode: FollowMode;
  followGitRoot: boolean;
}

export const SECTION = "herdrNavigator";

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    autoFollow: config.get<boolean>("autoFollow", true),
    socketPath: config.get<string>("socketPath", ""),
    cwdSource: config.get<CwdSource>("cwdSource", "auto"),
    debounceMs: config.get<number>("debounceMs", 150),
    cwdPollMs: config.get<number>("cwdPollMs", 1000),
    liveCwdProbe: config.get<boolean>("liveCwdProbe", true),
    gitBashPath: config.get<string>("gitBashPath", ""),
    followMode: parseFollowMode(config.get<unknown>("followMode")),
    followGitRoot: config.get<boolean>("followGitRoot", true),
  };
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}

export function setAutoFollow(value: boolean): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update("autoFollow", value, vscode.ConfigurationTarget.Global);
}
