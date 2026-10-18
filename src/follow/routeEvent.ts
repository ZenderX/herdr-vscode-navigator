import { POLL_EVENTS } from "./cwdPoller";

export interface EventRoutes {
  pollNow: () => void;
  /** Any event that is not a poll trigger: runs the normal focus path. */
  onFocusEvent: () => void;
}

/** Poll events only trigger an immediate cwd poll; every other event takes the focus path. */
export function routeHerdrEvent(event: string, routes: EventRoutes): void {
  if (POLL_EVENTS.has(event)) routes.pollNow();
  else routes.onFocusEvent();
}
