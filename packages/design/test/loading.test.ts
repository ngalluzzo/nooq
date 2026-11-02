/** The open state: nothing before the delay, the wordmark at it, done() wins (foundation P2). */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { LOADING_DELAY, loading } from "../src/index.ts";

/**
 * Deterministic time: `now()` is a knob, and scheduled wakes fire only when
 * the clock is advanced to them. Installs itself over the global scheduler
 * for the (synchronous) life of a test, like the announcer's FakeClock.
 */
class FakeClock {
  time = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();
  private readonly realSetTimeout = globalThis.setTimeout;
  private readonly realClearTimeout = globalThis.clearTimeout;
  now = (): number => this.time;
  install(): void {
    globalThis.setTimeout = ((run: () => void, ms?: number) => {
      const id = ++this.seq;
      this.tasks.set(id, { at: this.time + Math.max(0, ms ?? 0), run });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: unknown) => {
      if (typeof id === "number") this.tasks.delete(id);
    }) as typeof clearTimeout;
  }
  restore(): void {
    globalThis.setTimeout = this.realSetTimeout;
    globalThis.clearTimeout = this.realClearTimeout;
  }
  /** Advance to `ms`, firing every due wake in clock order as the clock passes it. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.tasks.delete(due[0]);
      due[1].run();
    }
    this.time = target;
  }
  /** Run the earliest queued wake WITHOUT moving the clock: a scheduler that fires early. */
  fireEarly(): void {
    const due = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) return;
    this.tasks.delete(due[0]);
    due[1].run();
  }
}

/** The motion preference as the component reads it, stubbed for the test's lifetime. */
function withMotion(reduce: boolean, run: () => void): void {
  const real = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({ matches: reduce && query.includes("reduce") })) as unknown as typeof matchMedia;
  try { run(); } finally { globalThis.matchMedia = real; }
}

/** A parent in the document, as a host mounts the loading element. */
function mount(host: HTMLElement): HTMLElement {
  const parent = document.createElement("div");
  document.body.append(parent);
  parent.append(host);
  return parent;
}

describe("loading", () => {
  test("the delay gate: nothing before it, the wordmark and the word at it", () => {
    const clock = new FakeClock();
    clock.install();
    try {
      withMotion(false, () => {
        const handle = loading({ now: clock.now });
        const parent = mount(handle.element);
        expect(handle.element.classList.contains("nq-loading")).toBe(true);
        expect(handle.element.getAttribute("style")).toBeNull();

        clock.advance(LOADING_DELAY - 1);
        expect(handle.element.getAttribute("aria-busy")).toBeNull(); // fast loads show nothing
        expect(handle.element.querySelector(".nq-logo")).toBeNull();
        expect(handle.element.textContent).toBe("");

        clock.advance(1);
        expect(handle.element.getAttribute("aria-busy")).toBe("true");
        expect(handle.element.querySelector(".nq-sr")?.textContent).toBe("Loading");
        const logo = handle.element.querySelector<SVGSVGElement>(".nq-logo")!;
        expect(logo).not.toBeNull();
        // The choreography began: frame 0 is drawn synchronously (§Motion: loading is a brand surface).
        expect(logo.dataset.phase).not.toBe("rest");
        handle.done();
      });
    } finally { clock.restore(); }
  });

  test("the clock decides, not the scheduler: an early wake re-arms for what it owes", () => {
    const clock = new FakeClock();
    clock.install();
    try {
      withMotion(false, () => {
        const handle = loading({ delay: 300, now: clock.now });
        clock.time = 100;
        clock.fireEarly(); // the queue's 300ms wake runs at clock-time 100
        expect(handle.element.querySelector(".nq-logo")).toBeNull(); // still owes 200ms
        clock.advance(199);
        expect(handle.element.querySelector(".nq-logo")).toBeNull();
        clock.advance(1);
        expect(handle.element.querySelector(".nq-logo")).not.toBeNull();
        handle.done();
      });
    } finally { clock.restore(); }
  });

  test("done() before the delay: nothing ever shows, and the host leaves the DOM", () => {
    const clock = new FakeClock();
    clock.install();
    try {
      withMotion(false, () => {
        const handle = loading({ now: clock.now });
        const parent = mount(handle.element);
        handle.done(); // the fast load finished inside the window
        clock.advance(LOADING_DELAY * 2); // even a leaked wake has nothing to say
        expect(parent.querySelector(".nq-loading")).toBeNull();
        expect(handle.element.isConnected).toBe(false);
        expect(handle.element.querySelector(".nq-logo")).toBeNull(); // nothing was ever drawn
        expect(handle.element.getAttribute("aria-busy")).toBeNull();
      });
    } finally { clock.restore(); }
  });

  test("done() while shown cancels the wordmark and removes the host; the logo is never left half-drawn", () => {
    const clock = new FakeClock();
    clock.install();
    try {
      withMotion(false, () => {
        const handle = loading({ now: clock.now });
        const parent = mount(handle.element);
        clock.advance(LOADING_DELAY);
        const logo = handle.element.querySelector<SVGSVGElement>(".nq-logo")!;
        handle.done();
        expect(parent.querySelector(".nq-loading")).toBeNull();
        expect(logo.dataset.phase).toBe("rest"); // cancel rests the Move, wherever it was
        clock.advance(LOADING_DELAY * 2); // the loop does not restart a finished loader
        expect(handle.element.querySelector(".nq-logo")).toBe(logo);
        expect(logo.dataset.phase).toBe("rest");
      });
    } finally { clock.restore(); }
  });

  test("a delay of 0 shows immediately: the test seam the surface uses", () => {
    withMotion(false, () => {
      const handle = loading({ delay: 0 });
      expect(handle.element.querySelector(".nq-logo")).not.toBeNull();
      expect(handle.element.getAttribute("aria-busy")).toBe("true");
      handle.done();
    });
  });

  test("under reduced motion the wordmark is at rest and never animates", () => {
    const clock = new FakeClock();
    clock.install();
    try {
      withMotion(true, () => {
        const handle = loading({ now: clock.now });
        const parent = mount(handle.element);
        clock.advance(LOADING_DELAY);
        const logo = handle.element.querySelector<SVGSVGElement>(".nq-logo")!;
        expect(logo.dataset.phase).toBe("rest");
        expect(logo.querySelector(".nq-logo-piece")?.classList.contains("is-moved")).toBe(true);
        expect(handle.element.querySelector(".nq-sr")?.textContent).toBe("Loading"); // the word still states it (§9)
        clock.advance(LOADING_DELAY * 4); // no loop under reduced motion
        expect(logo.dataset.phase).toBe("rest");
        handle.done();
      });
    } finally { clock.restore(); }
  });
});
