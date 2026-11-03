import type { Logger, SessionSnapshot } from "../herdr";

const MARKER = "herdr-navigation";

const DEFAULT_TEMPLATE = "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";
const DARWIN_DEFAULT_TEMPLATE = "${activeEditorShort}${separator}${rootName}${separator}${profileName}";
const ROOT_TOKEN = /\$\{rootName(?:Short)?\}/g;

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

/** The last title this extension wrote, kept so a later run can tell its own value from a user's. */
export interface RecordedTitle {
  get(): string | undefined;
  set(value: string | undefined): Promise<void>;
}

/** VS Code's template scanner has no escape: a `$` opens a variable, so it is swapped for a fullwidth dollar. */
function sanitizeLabel(label: string): string {
  return label.replace(/\$/g, "＄").replace(/[\r\n]+/g, " ");
}

/** Returns the title to write, or undefined when the template has no root-name token to replace. */
function buildWindowTitle(template: string, label: string): string | undefined {
  const slot = sanitizeLabel(label);
  const title = template.replace(ROOT_TOKEN, () => slot);
  return title === template ? undefined : title;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A value shaped like the template with a literal in the root slot was written by an earlier run, whatever label it carried; sanitizeLabel never lets a `$` through, so a `$` in the slot is the user's variable.
function matchesShape(template: string, value: string): boolean {
  const parts = template.split(ROOT_TOKEN);
  if (parts.length < 2 || parts.every((part) => part === "")) return false;
  return new RegExp(`^${parts.map(escapeRegExp).join("[^$]*")}$`).test(value);
}

/** The focused space's label, or undefined when no space is focused or it has no string label. */
export function focusedLabel(snapshot: SessionSnapshot): string | undefined {
  const label = snapshot.workspaces.find(({ workspace_id }) => workspace_id === snapshot.focused_workspace_id)?.label;
  return typeof label === "string" && label !== "" ? label : undefined;
}

export interface WindowTitleDeps {
  platform: NodeJS.Platform;
  config: () => WindowTitleConfig;
  recorded: RecordedTitle;
  /** The persisted last-focused label, used until a snapshot supplies one. */
  initialLabel: () => string | undefined;
  log: Logger;
}

/** The returned sync is idempotent, remembers the last label, and logs each skip reason once. */
export function createWindowTitleSync({
  platform,
  config,
  recorded,
  initialLabel,
  log,
}: WindowTitleDeps): (isNavigator: boolean, label?: string) => Promise<void> {
  const warned = new Set<string>();
  const warnOnce = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    log("info", `window title: ${message}`);
  };
  let lastLabel: string | undefined;

  return async (isNavigator, label) => {
    if (label !== undefined) lastLabel = label;
    const target = config();
    const inspected = target.inspect();
    const current = inspected?.workspaceValue;
    const fallback = platform === "darwin" ? DARWIN_DEFAULT_TEMPLATE : DEFAULT_TEMPLATE;
    const template = inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
    // Shape matching only applies in a navigator window: elsewhere it would claim a user's own title.
    const ours =
      current !== undefined &&
      (current.includes(MARKER) || current === recorded.get() || (isNavigator && matchesShape(template, current)));

    if (!isNavigator) {
      if (!ours) return;
      await target.update(undefined);
      await recorded.set(undefined);
      log("info", "window title: cleared the workspace value; this window is no longer a navigator window");
      return;
    }

    const title = buildWindowTitle(template, lastLabel ?? initialLabel() ?? MARKER);
    if (title === undefined) {
      if (ours) {
        await target.update(undefined);
        await recorded.set(undefined);
        log("info", "window title: cleared the workspace value; your window.title has no root-name token");
        return;
      }
      return warnOnce("your window.title has no ${rootName} or ${rootNameShort}; left unchanged");
    }
    if (current === title) return;
    if (current !== undefined && !ours) return warnOnce("a workspace window.title is already set; left unchanged");

    await target.update(title);
    await recorded.set(title);
    log("info", `window title: wrote ${title}`);
  };
}
