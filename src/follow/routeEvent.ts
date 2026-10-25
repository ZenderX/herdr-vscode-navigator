import { FOCUS_EVENTS, RECORD_EVENTS } from "../restore/record";
import { POLL_EVENTS } from "./cwdPoller";

export interface EventRoutes {
  pollNow: () => void;
  /** Pane, close and focus events for the return recorder. */
  record: () => void;
  /** Any event that is neither a poll trigger nor a pane or close recorder event: runs the normal focus path. */
  onFocusEvent: () => void;
}

/** Poll and pane/close recorder events never take the focus path; focus events take it and are recorded too. */
export function routeHerdrEvent(event: string, routes: EventRoutes): void {
  const poll = POLL_EVENTS.has(event);
  const paneRecord = RECORD_EVENTS.has(event);
  if (poll) routes.pollNow();
  if (paneRecord || FOCUS_EVENTS.has(event)) routes.record();
  if (!poll && !paneRecord) routes.onFocusEvent();
}
