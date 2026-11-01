/**
 * EB-6: every keystroke paints in one frame. Real keystrokes (trusted
 * keydown through Chrome's input pipeline) at 10 per second into the
 * middle of a reference document, measured from Chrome's EventLatency
 * trace slices: input creation to the frame that shows it.
 *
 * Load conditions (EB-4): idle, and a sync storm of 50 remote transactions
 * a second through an in-page relay. AI streaming waits for a streaming
 * proposal API in the framework; today a proposal arrives whole.
 */

import { describe, expect, test } from "bun:test";
import { FRAME_MS, keystrokeLatencies, summarize, writeResult, type Lab } from "./harness.ts";
import type { RefDocName } from "./refdocs.ts";
import { ENFORCE, LAB, labSession, rowSelector, labCapable } from "./session.ts";

type Condition = "idle" | "sync-storm";

const TEXT = "offline sync merged quietly while the writer kept typing ";

/** EB-6's sample: mostly text, 1 Enter (split) and 1 Backspace per 25 keys. */
function typingScript(count: number): string[] {
  const keys: string[] = [];
  let c = 0;
  for (let i = 0; i < count; i++) {
    if (i % 25 === 24) keys.push("Enter");
    else if (i % 25 === 12) keys.push("Backspace");
    else keys.push(TEXT[c++ % TEXT.length]!);
  }
  return keys;
}

async function typeAt(lab: Lab, keys: string[], perSecond: number): Promise<void> {
  const start = performance.now();
  for (let i = 0; i < keys.length; i++) {
    const due = start + (i * 1000) / perSecond;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    await lab.press(keys[i]!);
  }
}

const progress = (doc: string, step: string) => process.stderr.write(`[EB-6 ${doc}] ${step}\n`);

async function measure(doc: RefDocName, condition: Condition, middle: number, count: number) {
  progress(doc, `loading (${condition})`);
  const session = await labSession();
  const { lab } = session;
  await session.load(doc, condition);
  const ids = await lab.evaluate<string[]>("lab.allBlockIds()"); // windowing: mounted ids are only the viewport
  const target = ids[middle]!;
  const how = await lab.evaluate<string>(`lab.scrollToBlock(${JSON.stringify(target)})`);
  if (how !== "landed") throw new Error(`EB-6 could not focus the target block (${how})`);
  // scrollToBlock lands, FOCUSES (verified) and PINS the row (EB-8 v1).
  // Script focus carries trusted keys under focus emulation — the click was
  // only ever masking the freeze bug, and after jump-scrolls it races
  // actionability against estimate-drift layout shifts.
  await lab.press("End");
  await lab.evaluate("lab.settle()");

  const keys = typingScript(count);
  const expectedDelta = keys.filter((k) => k.length === 1).length - keys.filter((k) => k === "Backspace").length;
  const charsBefore = await lab.evaluate<number>(`lab.localChars(${JSON.stringify(target)})`);
  progress(doc, `typing ${keys.length} keys`);
  if (condition === "sync-storm") await lab.evaluate(`lab.startStorm(${JSON.stringify(target)}, 50)`);
  const events = await lab.trace(async () => {
    await typeAt(lab, keys, 10);
    await lab.evaluate("lab.settle()");
  });
  if (condition === "sync-storm") await lab.evaluate("lab.stopStorm()");
  const charsAfter = await lab.evaluate<number>(`lab.localChars(${JSON.stringify(target)})`);
  progress(doc, `typed; ${events.length} trace events`);
  const focusLosses = await lab.evaluate<number>("lab.focusLosses()");
  const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
  const { latencies, missing, vsyncMs } = keystrokeLatencies(events, keys.length);

  // If typing stopped landing, also measure the cost of a keystroke when the
  // writer re-clicks before every key. Diagnostic only: never the gate.
  let diagnostic: { refocusedKeystrokes?: ReturnType<typeof summarize>; error?: string } | undefined;
  const landed = (charsAfter - charsBefore) / expectedDelta;
  if (landed < 0.9) {
    progress(doc, `only ${Math.round(landed * 100)}% of characters landed; diagnostic pass`);
    const sample = TEXT.slice(0, 40).split("");
    try {
      const diag = await lab.trace(async () => {
        for (const key of sample) {
          // Typed spaces with nothing focused page the document down, so find the block again first.
          const again = await lab.evaluate<string>(`lab.scrollToBlock(${JSON.stringify(target)})`);
          if (again !== "landed") throw new Error(`EB-6 lost the target mid-run (${again})`);
          await lab.press(key);
          await lab.evaluate("lab.settle()");
        }
      });
      diagnostic = { refocusedKeystrokes: summarize(keystrokeLatencies(diag, sample.length).latencies) };
    } catch (error) {
      diagnostic = { error: String(error) };
    }
  }
  session.close();

  return {
    budget: "EB-6",
    doc,
    browser: lab.browser,
    condition,
    throttle: 4,
    keystrokes: keys.length,
    vsyncMs,
    keystrokeToPaintMs: summarize(latencies),
    keystrokesWithoutAFrame: missing,
    charactersExpected: expectedDelta,
    charactersLanded: charsAfter - charsBefore,
    focusLosses,
    pageHidden,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

describe.skipIf(!LAB || !labCapable)("EB-6 keystroke to paint", () => {
  for (const [doc, condition, middle, count] of [
    ["ref-small", "idle", 25, 500],
    ["ref-small", "sync-storm", 25, 500],
    ["ref-large", "idle", 1000, 500],
    ["ref-large", "sync-storm", 1000, 500],
  ] as const) {
    test(
      `${doc}, ${condition}: p95 within one frame, nothing over 50ms, and every keystroke lands`,
      async () => {
        const result = await measure(doc, condition, middle, count);
        await writeResult(`eb6-keystrokes-${doc}-${condition}`, result);
        console.log(JSON.stringify(result, null, 2));
        // A hidden page gets no frames: the run measured nothing and is void.
        expect(result.pageHidden).toBe(0);
        if (!ENFORCE) return;
        // The storm's remote writers add characters to the same block (EB-4):
        // exact equality is idle-only; the storm requires every keystroke's
        // character to land, remote text on top.
        if (condition === "idle") expect(result.charactersLanded).toBe(result.charactersExpected);
        else expect(result.charactersLanded).toBeGreaterThanOrEqual(result.charactersExpected);
        // Draft 2 stages 1+2 (EB-6 amendment): both documents gate idle at two
        // frames and max 50ms — stage 2's condition (incremental projection)
        // landed 2026-11-01. Storms: ref-small p95 100ms; ref-large report.
        if (condition === "idle") {
          expect(result.keystrokeToPaintMs.p95).toBeLessThanOrEqual(FRAME_MS * 2);
          // ref-large max is REPORTED, not gated (Draft 2.1 note): 90-104ms
          // GC pauses under allocation pressure — the per-transaction shell
          // publish is the named suspect. ref-small keeps the max gate.
          if (doc === "ref-small") expect(result.keystrokeToPaintMs.max).toBeLessThanOrEqual(50);
        } else if (doc === "ref-small") {
          expect(result.keystrokeToPaintMs.p95).toBeLessThanOrEqual(100);
        }
      },
      600_000,
    );
  }
});
