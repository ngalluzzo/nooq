import { el } from "../dom.ts";

/**
 * The quiet window between announcements (foundation: Announcer). At most one
 * announcement per window; a message arriving inside it replaces any pending
 * one, so bursts drop intermediates and the latest wins.
 */
export const ANNOUNCE_QUIET = 750;

/** Injectable time, so the rate limit is testable with a fake clock. */
export interface AnnouncerTiming {
  now(): number;
  /**
   * Run `task` no sooner than `delay` ms from now; returns a cancel function.
   * A scheduler that fires early breaks the rate limit's guarantee.
   */
  schedule(delay: number, task: () => void): () => void;
}

export interface Announcer {
  /** The live region itself. Mount it once and never replace it. */
  element: HTMLSpanElement;
  /** Semantic events only, never per keystroke (§9). */
  say(text: string): void;
}

const defaultTiming: AnnouncerTiming = {
  now: () => Date.now(),
  schedule: (delay, task) => {
    const id = setTimeout(task, delay);
    return () => clearTimeout(id);
  },
};

/**
 * One persistent live region for "Tomás joined." / "Suggestion is now stale."
 * style announcements: `role="status"`, polite, visually hidden (.nq-sr).
 * Rate-limited to one announcement per ANNOUNCE_QUIET ms; inside the quiet
 * window the latest message replaces any pending one, so a burst never churns
 * screen-reader output — intermediates drop, the newest waits its turn.
 *
 * Usage: create one per page (or share the editor's via its status area),
 * mount `element` anywhere in the DOM, and keep it mounted; replacing the
 * region per message is what makes assistive tech miss announcements.
 * Callers pass semantic events only: joins, leaves, state changes — never
 * anything that fires per keystroke (§9).
 */
export function announcer(timing: AnnouncerTiming = defaultTiming): Announcer {
  const element = el("span", { class: "nq-announcer nq-sr", role: "status", "aria-live": "polite" });
  let last = -Infinity, pending: string | undefined, cancel: (() => void) | undefined;
  const speak = (text: string, at: number): void => {
    // Clear, then set: an identical sentence repeated must re-announce.
    element.textContent = "";
    element.textContent = text;
    last = at;
  };
  const flush = (): void => {
    cancel = undefined;
    if (pending === undefined) return;
    const message = pending;
    pending = undefined;
    speak(message, timing.now());
  };
  return {
    element,
    say(text) {
      if (!text) return;
      const now = timing.now();
      if (now - last >= ANNOUNCE_QUIET) {
        // Outside the quiet window: speak now, and anything pending is dead —
        // its message was superseded and its flush would only speak stale text.
        cancel?.();
        cancel = undefined;
        pending = undefined;
        speak(text, now);
        return;
      }
      // Inside the quiet window: latest wins, intermediates drop.
      pending = text;
      if (!cancel) cancel = timing.schedule(ANNOUNCE_QUIET - (now - last), flush);
    },
  };
}
