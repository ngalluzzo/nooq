import { el } from "../dom.ts";
import { animateWordmark, wordmark, type WordmarkAnimation } from "../brand/wordmark.ts";

/**
 * How long a load may take before anything shows (foundation P2). Fast loads
 * settle inside the delay and show nothing at all.
 */
export const LOADING_DELAY = 300;

export interface LoadingOptions {
  /**
   * The quiet window before the loading state appears, in ms. Default 300
   * (`LOADING_DELAY`): a load that finishes inside it never shows anything.
   */
  delay?: number;
  /** Time source for the delay gate. Default `Date.now`; injectable so the gate is testable with a fake clock. */
  now?: () => number;
}

export interface LoadingHandle {
  /**
   * The loading host. Mount it immediately over whatever is opening; it is
   * positioned, grounded and pointer-transparent through the theme, and stays
   * empty until the delay has elapsed.
   */
  element: HTMLElement;
  /**
   * The load finished. Cancels a pending show, stops the wordmark and removes
   * the host from the DOM. Idempotent.
   */
  done(): void;
}

/**
 * The open state (foundation P2): nothing until `delay` has elapsed — fast
 * loads show nothing — then the wordmark at loader timing, centered on paper,
 * looping for as long as it is shown. The Move rests at its end, so the loop
 * restarts the choreography; under `prefers-reduced-motion` the wordmark is at
 * rest and never animates (brand book, Motion — loading is a brand surface,
 * the one place the logo may run). While shown, the host carries `aria-busy`
 * and the visually hidden word "Loading" (§9).
 *
 * Usage: mount `element` in a positioned container the moment a load starts
 * and call `done()` when the content is there. Do not use it for anything on
 * the input path — it exists only before the first render (§3); windowed
 * skeletons cover scrolling, not opening.
 */
export function loading({ delay = LOADING_DELAY, now = () => Date.now() }: LoadingOptions = {}): LoadingHandle {
  const element = el("div", { class: "nq-loading" });
  const dueAt = now() + delay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: WordmarkAnimation | undefined;
  let finished = false;

  const show = (): void => {
    if (finished) return;
    timer = undefined;
    element.setAttribute("aria-busy", "true");
    const logo = wordmark();
    element.append(el("span", { class: "nq-sr" }, "Loading"), logo);
    // The same check animateWordmark makes by default, hoisted so the loop
    // knows whether restarting is allowed: under reduced motion the wordmark
    // rests and never moves — one call, no loop.
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const play = (): void => {
      running = animateWordmark(logo, { timing: "loader", reducedMotion: reduce });
      // The Move ends at rest; a loader still shown begins it again.
      if (!reduce) void running.finished.then(() => { if (!finished) play(); });
    };
    play();
  };

  const fire = (): void => {
    timer = undefined;
    // The clock decides, not the scheduler: a timer that fires early re-arms
    // for whatever the clock still owes (the announcer's contract).
    const owing = dueAt - now();
    if (owing > 0) { timer = setTimeout(fire, owing); return; }
    show();
  };

  if (delay <= 0) show();
  else timer = setTimeout(fire, delay);

  return {
    element,
    done() {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Whatever happens, the logo is never left half-drawn: cancel rests it.
      running?.cancel();
      element.remove();
    },
  };
}
