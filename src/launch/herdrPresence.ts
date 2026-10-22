import type { Logger } from "../herdr";
import { errorText } from "../log";

export const HERDR_INSTALL_URL = "https://herdr.dev/docs/install/";

/** `unknown` holds until the first resolution completes, so startup never flashes "not installed". */
export type HerdrPresenceState = { state: "found"; path: string } | { state: "not-found" } | { state: "unknown" };

export interface PresenceDeps {
  resolve: () => Promise<string | undefined>;
  /** Reports window focus changes; `focused` is true on gain. */
  subscribeFocus: (listener: (focused: boolean) => void) => { dispose(): void };
  log: Logger;
}

/** Last known result of resolving the herdr binary; re-resolved only on focus gain while missing, or on request. Never polled. */
export class HerdrPresence {
  private current: HerdrPresenceState = { state: "unknown" };
  private inflight: Promise<HerdrPresenceState> | undefined;
  private readonly listeners = new Set<(state: HerdrPresenceState) => void>();
  private readonly focusSubscription: { dispose(): void };

  constructor(private readonly deps: PresenceDeps) {
    this.focusSubscription = deps.subscribeFocus((focused) => {
      if (focused && this.current.state !== "found") void this.recheck();
    });
  }

  get(): HerdrPresenceState {
    return this.current;
  }

  onChange(listener: (state: HerdrPresenceState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Overlapping calls share one resolution. Never rejects. */
  recheck(): Promise<HerdrPresenceState> {
    this.inflight ??= this.resolveNow().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  dispose(): void {
    this.focusSubscription.dispose();
    this.listeners.clear();
  }

  private async resolveNow(): Promise<HerdrPresenceState> {
    let path: string | undefined;
    try {
      path = await this.deps.resolve();
    } catch (err: unknown) {
      // A failed lookup proves nothing: keep the previous state.
      this.deps.log("warn", `herdr presence: ${errorText(err)}`);
      return this.current;
    }
    const next: HerdrPresenceState = path === undefined ? { state: "not-found" } : { state: "found", path };
    const changed = next.state !== this.current.state || (next.state === "found" && this.current.state === "found" && next.path !== this.current.path);
    this.current = next;
    if (changed) for (const listener of this.listeners) listener(next);
    return next;
  }
}

export interface NotInstalledClickDeps {
  recheck: () => Promise<HerdrPresenceState>;
  /** The click behaviour for an installed herdr (launch, or toggle auto-follow). */
  runInstalled: () => Promise<void>;
  openExternal: (url: string) => PromiseLike<unknown>;
}

/** Click on the main item while it shows "not installed": re-check first, so a fresh install works without a reload. */
export async function handleNotInstalledClick({ recheck, runInstalled, openExternal }: NotInstalledClickDeps): Promise<void> {
  if ((await recheck()).state === "found") return runInstalled();
  await openExternal(HERDR_INSTALL_URL);
}
