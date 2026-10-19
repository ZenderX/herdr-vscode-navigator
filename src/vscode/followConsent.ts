import { FOLDER_SWITCH_CONFIRM, FOLDER_SWITCH_NOTICE } from "../follow";
import type { FollowMode } from "../follow/followMode";
import { mayFollowAutomatically } from "../hosting";
import type { HostState } from "../hosting";

const CONFIRM_KEY = "herdrNavigator.followHere";
const NOTICE_SHOWN_KEY = "herdrNavigator.folderSwitchNoticeShown";
const FOLLOW_HERE = "Follow herdr in this window";

interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface FollowConsentDeps {
  host: { get: () => HostState };
  /** Per-window: remembers the answer to the follow-here prompt. */
  workspaceState: Memento;
  /** Shared by all windows: remembers the one-time folder-switch notice. */
  globalState: Memento;
  /** Shows a modal prompt; resolves with the chosen item, or undefined when dismissed. */
  askModal: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  followMode: () => FollowMode;
  /** Refreshes the hosting result; only a conversion forces a fresh scan. */
  requestHosting: (force: boolean) => Promise<void>;
  refreshStatus: () => void;
}

export interface FollowConsent {
  /** undefined: never asked; false: declined here. */
  confirmedHere: () => boolean | undefined;
  autoAllowed: () => boolean;
  suppressionReason: () => string;
  /** Whether an automatic plan may touch this window; asks the user when hosting is undetectable. */
  guardAuto: (forceScan: boolean) => Promise<boolean>;
  /** The first folder-mode switch per installation needs an explicit yes. */
  confirmFolderSwitch: () => Promise<boolean>;
  confirmFollowHere: () => Promise<boolean>;
  /** An explicit Follow Now command bypasses the guard while it runs. */
  setManualFollow: (value: boolean) => void;
  /** Reconnect: forget the answer and any dismissal so the user is asked again. */
  reset: () => Promise<void>;
  /** Takes over a confirmation that travelled with a pending intent into this fresh workspace. */
  adopt: () => Promise<void>;
}

export function createFollowConsent(deps: FollowConsentDeps): FollowConsent {
  const { host, workspaceState, globalState } = deps;
  let confirmedHere = workspaceState.get<boolean>(CONFIRM_KEY);
  let manualFollow = false;
  let dismissed = false;
  let confirming: Promise<boolean> | undefined;

  const autoAllowed = (): boolean => mayFollowAutomatically(host.get(), confirmedHere);

  const suppressionReason = (): string =>
    host.get() !== "unknown"
      ? "auto-follow suppressed: this window does not host herdr"
      : confirmedHere === false
        ? "auto-follow suppressed: hosting could not be detected and following here was declined"
        : dismissed
          ? "auto-follow suppressed: hosting could not be detected; run Reconnect to be asked again"
          : "auto-follow waiting: hosting could not be detected; confirmation needed for this window";

  // When detection failed, the first automatic plan needs the user's say-so for this window; Escape declines until Reconnect.
  const confirmFollowHere = (): Promise<boolean> => {
    if (confirmedHere !== undefined) return Promise.resolve(confirmedHere);
    if (dismissed) return Promise.resolve(false);
    confirming ??= (async () => {
      try {
        const choice = await deps.askModal(
          deps.followMode() === "folder"
            ? "Herdr Navigator cannot tell whether this window hosts herdr. Following reloads this window on every switch and closes its integrated terminals."
            : "Herdr Navigator cannot tell whether this window hosts herdr. Following changes this window's workspace folders and may convert it to a multi-root workspace, restarting extensions once.",
          FOLLOW_HERE,
          "Not in this window",
        );
        if (choice === undefined) {
          dismissed = true;
        } else {
          confirmedHere = choice === FOLLOW_HERE;
          await workspaceState.update(CONFIRM_KEY, confirmedHere);
        }
      } finally {
        confirming = undefined;
      }
      deps.refreshStatus();
      return confirmedHere === true;
    })();
    return confirming;
  };

  // The first folder-mode switch per installation needs an explicit yes (modal, so it cannot linger); declining abandons that switch and asks again next time.
  const confirmFolderSwitch = async (): Promise<boolean> => {
    if (globalState.get<boolean>(NOTICE_SHOWN_KEY) === true) return true;
    const choice = await deps.askModal(FOLDER_SWITCH_NOTICE, FOLDER_SWITCH_CONFIRM);
    if (choice !== FOLDER_SWITCH_CONFIRM) return false;
    await globalState.update(NOTICE_SHOWN_KEY, true);
    return true;
  };

  return {
    confirmedHere: () => confirmedHere,
    autoAllowed,
    suppressionReason,
    guardAuto: async (forceScan) => {
      if (manualFollow) return true;
      await deps.requestHosting(forceScan);
      if (autoAllowed()) return true;
      return host.get() === "unknown" && (await confirmFollowHere());
    },
    confirmFolderSwitch,
    confirmFollowHere,
    setManualFollow: (value) => {
      manualFollow = value;
    },
    reset: async () => {
      dismissed = false;
      confirmedHere = undefined;
      await workspaceState.update(CONFIRM_KEY, undefined);
    },
    adopt: async () => {
      confirmedHere = true;
      await workspaceState.update(CONFIRM_KEY, true);
    },
  };
}
