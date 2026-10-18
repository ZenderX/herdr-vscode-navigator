import type { Logger } from "../herdr";

const MARKER = "herdr-navigation";
const LONG_NAME = `${MARKER} (Workspace)`;

const DEFAULT_TEMPLATE = "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";
const DARWIN_DEFAULT_TEMPLATE = "${activeEditorShort}${separator}${rootName}${separator}${profileName}";

export interface TitleInspection {
  globalValue?: string;
  defaultValue?: string;
  workspaceValue?: string;
}

/** `update` writes `window.title` at Workspace scope only; the VS Code binding owns that target. */
export interface WindowTitleConfig {
  inspect(): TitleInspection | undefined;
  update(value: string | undefined): Promise<void>;
}

/** Returns the title to write, or undefined when the template has no root-name token to replace. */
export function buildWindowTitle(template: string): string | undefined {
  const title = template.split("${rootName}").join(LONG_NAME).split("${rootNameShort}").join(MARKER);
  return title === template ? undefined : title;
}

export interface WindowTitleDeps {
  platform: NodeJS.Platform;
  config: () => WindowTitleConfig;
  log: Logger;
}

/** The returned sync is idempotent and logs each skip reason once. */
export function createWindowTitleSync({ platform, config, log }: WindowTitleDeps): (isNavigator: boolean) => Promise<void> {
  const warned = new Set<string>();
  const warnOnce = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    log("info", `window title: ${message}`);
  };

  return async (isNavigator) => {
    const target = config();
    const inspected = target.inspect();
    const current = inspected?.workspaceValue;
    const ours = current?.includes(MARKER) === true;

    if (!isNavigator) {
      if (!ours) return;
      await target.update(undefined);
      log("info", "window title: cleared the workspace value; this window is no longer a navigator window");
      return;
    }

    const fallback = platform === "darwin" ? DARWIN_DEFAULT_TEMPLATE : DEFAULT_TEMPLATE;
    const template = inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
    const title = buildWindowTitle(template);
    if (title === undefined) {
      if (ours) {
        await target.update(undefined);
        log("info", "window title: cleared the workspace value; your window.title has no root-name token");
        return;
      }
      return warnOnce("your window.title has no ${rootName} or ${rootNameShort}; left unchanged");
    }
    if (current === title) return;
    if (current !== undefined && !ours) return warnOnce("a workspace window.title is already set; left unchanged");

    await target.update(title);
    log("info", `window title: wrote ${title}`);
  };
}
