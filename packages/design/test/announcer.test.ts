/** The announcer's rate limit: one announcement per quiet window, latest wins (§9). */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { ANNOUNCE_QUIET, announcer, type AnnouncerTiming } from "../src/index.ts";

/** A deterministic clock: now() is a knob and scheduled tasks fire only when advanced to. */
class FakeClock implements AnnouncerTiming {
  time = 0;
  private readonly tasks = new Map<() => void, { at: number; run: () => void }>();
  now(): number { return this.time; }
  schedule(delay: number, task: () => void): () => void {
    const entry = { at: this.time + delay, run: task };
    this.tasks.set(task, entry);
    return () => { this.tasks.delete(task); };
  }
  /** Advance to `ms`, firing every due task in schedule order as the clock passes it. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.tasks.values()].filter(entry => entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = due.at;
      this.tasks.delete(due.run);
      due.run();
    }
    this.time = target;
  }
}

const quiet = () => ANNOUNCE_QUIET;

describe("announcer", () => {
  test("one persistent polite live region, visually hidden", () => {
    const clock = new FakeClock(), a = announcer(clock);
    expect(a.element.getAttribute("role")).toBe("status");
    expect(a.element.getAttribute("aria-live")).toBe("polite");
    expect(a.element.classList.contains("nq-sr")).toBe(true);
    a.say("Tomás joined.");
    const mounted = a.element;
    document.body.append(mounted);
    clock.advance(quiet());
    a.say("Suggestion is now stale.");
    // The region is never replaced: the same mounted node holds both announcements.
    expect(a.element).toBe(mounted);
    expect(a.element.isConnected).toBe(true);
    expect(a.element.textContent).toBe("Suggestion is now stale.");
    mounted.remove();
  });

  test("the first message speaks immediately; the window opens after it", () => {
    const clock = new FakeClock(), a = announcer(clock);
    a.say("Tomás joined.");
    expect(a.element.textContent).toBe("Tomás joined.");
    clock.advance(quiet() - 1);
    a.say("Maya joined.");
    expect(a.element.textContent).toBe("Tomás joined."); // still inside the quiet window
    clock.advance(quiet());
    expect(a.element.textContent).toBe("Maya joined.");
  });

  test("a burst drops intermediates: the latest pending message wins", () => {
    const clock = new FakeClock(), a = announcer(clock);
    a.say("first");
    a.say("second");
    a.say("third");
    a.say("fourth");
    expect(a.element.textContent).toBe("first");
    clock.advance(quiet());
    expect(a.element.textContent).toBe("fourth");
    expect(a.element.textContent).not.toContain("second");
    expect(a.element.textContent).not.toContain("third");
  });

  test("at most one announcement per 750ms across pending flushes", () => {
    const clock = new FakeClock(), a = announcer(clock);
    a.say("one"); // spoken at 0
    clock.advance(100);
    a.say("two"); // pending, flushes at 750
    clock.advance(quiet());
    expect(a.element.textContent).toBe("two"); // spoken at 750, not before
    clock.advance(50);
    a.say("three"); // 800: inside the new quiet window (750–1500)
    expect(a.element.textContent).toBe("two");
    clock.advance(quiet());
    expect(a.element.textContent).toBe("three"); // spoken at 1500
  });

  test("a message after the quiet window speaks immediately and cancels the pending flush", () => {
    const clock = new FakeClock(), a = announcer(clock);
    a.say("one"); // spoken at 0
    clock.advance(100);
    a.say("two"); // pending, flush at 750
    clock.advance(quiet() + 700); // past 750: "two" flushed long ago; the window closed at 1500
    a.say("three"); // spoken now, immediately
    expect(a.element.textContent).toBe("three");
    clock.advance(quiet());
    expect(a.element.textContent).toBe("three"); // no stale "two" resurrection
  });

  test("an identical sentence repeated still re-announces", () => {
    const clock = new FakeClock(), a = announcer(clock);
    a.say("Suggestion is now stale.");
    clock.advance(quiet());
    a.say("Suggestion is now stale.");
    // Clear-then-set: the text reads the same, and the node is not replaced.
    expect(a.element.textContent).toBe("Suggestion is now stale.");
    expect(a.element.childElementCount).toBe(0); // plain text, no churn of children
  });

  test("nothing to say, nothing spoken", () => {
    const a = announcer(new FakeClock());
    a.say("");
    expect(a.element.textContent).toBe("");
  });
});
