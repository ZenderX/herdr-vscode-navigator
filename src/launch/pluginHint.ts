import type { HerdrPresenceState } from "./herdrPresence";
import type { PluginState } from "./pluginDetect";

export const PLUGIN_INSTALL_COMMAND = "herdr plugin install ZenderX/herdr-vscode-navigator/plugin";
export const PLUGIN_README_URL = "https://github.com/ZenderX/herdr-vscode-navigator/blob/main/plugin/README.md";
export const PLUGIN_HINT_DISMISSED_KEY = "herdrNavigator.pluginHintDismissed";

export const HINT_EXPLANATION =
  "The optional herdr plugin re-focuses your last space after herdr crashes, is force-killed or the machine reboots, including when herdr runs outside VS Code.";
export const HINT_INSTALL = "Install";
export const HINT_LEARN_MORE = "Learn more";
export const HINT_DISMISS = "Don't show again";

/** Only a herdr that is found, a plugin known to be missing or disabled, and no dismissal show the hint. */
export function shouldShowHint(presence: HerdrPresenceState, dismissed: boolean, plugin: PluginState): boolean {
  return presence.state === "found" && !dismissed && plugin === "absent";
}

export interface PluginHintDeps {
  presence: { get: () => HerdrPresenceState; onChange: (listener: (state: HerdrPresenceState) => void) => { dispose(): void } };
  /** Never rejects; `unknown` on any failure. */
  detect: (herdrPath: string) => Promise<PluginState>;
  isDismissed: () => boolean;
  setDismissed: () => PromiseLike<void>;
  setVisible: (visible: boolean) => void;
}

/** Detection runs only on `refresh()` and when presence flips; never on a timer. */
export class PluginHint {
  private plugin: PluginState = "unknown";
  private inflight: Promise<void> | undefined;
  private readonly subscription: { dispose(): void };

  constructor(private readonly deps: PluginHintDeps) {
    this.subscription = deps.presence.onChange(({ state }) => {
      if (state === "found") void this.refresh();
      else this.apply();
    });
  }

  /** Overlapping calls share one detection. */
  refresh(): Promise<void> {
    this.inflight ??= this.detectNow().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The last detection; `unknown` until the first `refresh()` finishes or while herdr is not found. */
  pluginState(): PluginState {
    return this.plugin;
  }

  async dismiss(): Promise<void> {
    await this.deps.setDismissed();
    this.apply();
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async detectNow(): Promise<void> {
    const presence = this.deps.presence.get();
    if (presence.state === "found") this.plugin = await this.deps.detect(presence.path);
    this.apply();
  }

  private apply(): void {
    this.deps.setVisible(shouldShowHint(this.deps.presence.get(), this.deps.isDismissed(), this.plugin));
  }
}

export interface InstallTerminal {
  show(): void;
  sendText(text: string, shouldExecute?: boolean): void;
}

export interface InstallDeps<T extends InstallTerminal> {
  createTerminal: () => T;
  onDidCloseTerminal: (listener: (terminal: T) => void) => { dispose(): void };
  refresh: () => Promise<void>;
}

/** Herdr's own preview asks for confirmation, so the command carries no `--yes`. Its exit status is undocumented, so any close re-detects. */
export function installPluginInTerminal<T extends InstallTerminal>({ createTerminal, onDidCloseTerminal, refresh }: InstallDeps<T>): void {
  const terminal = createTerminal();
  const subscription = onDidCloseTerminal((closed) => {
    if (closed !== terminal) return;
    subscription.dispose();
    void refresh();
  });
  terminal.show();
  terminal.sendText(PLUGIN_INSTALL_COMMAND, true);
}

export interface HintClickDeps {
  showMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  openExternal: (url: string) => PromiseLike<unknown>;
  install: () => void;
  dismiss: () => Promise<void>;
}

export async function handlePluginHintClick({ showMessage, openExternal, install, dismiss }: HintClickDeps): Promise<void> {
  const choice = await showMessage(HINT_EXPLANATION, HINT_INSTALL, HINT_LEARN_MORE, HINT_DISMISS);
  if (choice === HINT_INSTALL) install();
  else if (choice === HINT_LEARN_MORE) await openExternal(PLUGIN_README_URL);
  else if (choice === HINT_DISMISS) await dismiss();
}
