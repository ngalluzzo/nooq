/**
 * EB-6: every keystroke paints in one frame. Real keystrokes (trusted
 * keydown through Chrome's input pipeline) at 10 per second into the
 * middle of a reference document, measured from Chrome's EventLatency
 * trace slices: input creation to the frame that shows it.
 *
 * Load condition: idle only in this first version (EB-4 sync storm and
 * AI streaming follow once the editor supports them in the lab page).
 */

import { describe, expect, test } from "bun:test";
import { FRAME_MS, keystrokeLatencies, summarize, writeResult, type Lab } from "./harness.ts";
import type { RefDocName } from "./refdocs.ts";
import { LAB, labSession, rowSelector } from "./session.ts";

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

async function measure(doc: RefDocName, middle: number, count: number) {
  const session = await labSession();
  const { lab } = session;
  await session.load(doc);
  const ids = await lab.evaluate<string[]>("lab.blockIds()");
  const target = ids[middle]!;
  await lab.scrollTo(rowSelector(target));
  await lab.click(rowSelector(target));
  await lab.press("End");
  await lab.evaluate("lab.settle()");

  const keys = typingScript(count);
  const expectedDelta = keys.filter((k) => k.length === 1).length - keys.filter((k) => k === "Backspace").length;
  const charsBefore = await lab.evaluate<number>("lab.totalChars()");
  const events = await lab.trace(async () => {
    await typeAt(lab, keys, 10);
    await lab.evaluate("lab.settle()");
  });
  const charsAfter = await lab.evaluate<number>("lab.totalChars()");
  const focusLosses = await lab.evaluate<number>("lab.focusLosses()");
  const { latencies, missing, vsyncMs } = keystrokeLatencies(events, keys.length);

  // If typing stopped landing, also measure the cost of a keystroke when the
  // writer re-clicks before every key. Diagnostic only: never the gate.
  let diagnostic: { refocusedKeystrokes: ReturnType<typeof summarize> } | undefined;
  const landed = (charsAfter - charsBefore) / expectedDelta;
  if (landed < 0.9) {
    const sample = TEXT.slice(0, 40).split("");
    const diag = await lab.trace(async () => {
      for (const key of sample) {
        await lab.click(rowSelector(target));
        await lab.press(key);
        await lab.evaluate("lab.settle()");
      }
    });
    diagnostic = { refocusedKeystrokes: summarize(keystrokeLatencies(diag, sample.length).latencies) };
  }
  session.close();

  return {
    budget: "EB-6",
    doc,
    browser: lab.browser,
    condition: "idle",
    throttle: 4,
    keystrokes: keys.length,
    vsyncMs,
    keystrokeToPaintMs: summarize(latencies),
    keystrokesWithoutAFrame: missing,
    charactersExpected: expectedDelta,
    charactersLanded: charsAfter - charsBefore,
    focusLosses,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

describe.skipIf(!LAB)("EB-6 keystroke to paint", () => {
  for (const [doc, middle, count] of [
    ["ref-small", 25, 500],
    ["ref-large", 1000, 500],
  ] as const) {
    test(
      `${doc}: p95 within one frame, nothing over 50ms, and every keystroke lands`,
      async () => {
        const result = await measure(doc, middle, count);
        await writeResult(`eb6-keystrokes-${doc}`, result);
        console.log(JSON.stringify(result, null, 2));
        expect(result.charactersLanded).toBe(result.charactersExpected);
        expect(result.keystrokeToPaintMs.p95).toBeLessThanOrEqual(FRAME_MS);
        expect(result.keystrokeToPaintMs.max).toBeLessThanOrEqual(50);
      },
      600_000,
    );
  }
});
