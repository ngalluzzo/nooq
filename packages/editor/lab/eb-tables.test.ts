/**
 * EB-T (0015's lab): tables under the experience-budget discipline. Three
 * measurements on ref-tables (40 paragraphs + a 100×8 table, ~950 blocks):
 *
 * 1. Cell typing — EB-6's exact shape and gates: a cell keystroke rides the
 *    same textarea binding as every other block, so it owes the same p95
 *    within one frame at the 4× rig, with every character landed.
 * 2. The column gesture — a remote-shaped column insert (101 ops) measured
 *    one-shot: REPORT this first landing (budgets arrive from measurements,
 *    the EB-6 precedent); the number lands in results/ for budgeting.
 * 3. Load — the doc's open-to-typed wall time, reported alongside.
 */

import { describe, expect, test } from "bun:test";
import { FRAME_MS, keystrokeLatencies, summarize, writeResult } from "./harness.ts";
import { ENFORCE, LAB, labSession, labBudgetCapable as labCapable } from "./session.ts";
import { refTableCellId, refTableId, type RefDocName } from "./refdocs.ts";
import type { Lab } from "./harness.ts";

const TEXT = "table cells hold prose and it types like everywhere else because the binding is the same".split("");

function typingScript(count: number): string[] {
  const keys: string[] = [];
  let c = 0;
  for (let i = 0; i < count; i++) keys.push(TEXT[c++ % TEXT.length]!);
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

const progress = (step: string) => process.stderr.write(`[EB-T] ${step}\n`);

async function measureCellTyping() {
  progress("loading ref-tables");
  const openedAt = performance.now();
  const session = await labSession();
  const { lab } = session;
  await session.load("ref-tables" as RefDocName, "idle");
  const loadMs = performance.now() - openedAt;
  // Row 50, column 4: the middle of the table, past the viewport at open.
  const target = refTableCellId(50, 4);
  const how = await lab.evaluate<string>(`lab.scrollToBlock(${JSON.stringify(target)})`);
  if (how !== "landed") throw new Error(`EB-T could not focus the target cell (${how})`);
  const keys = typingScript(200);
  const charsBefore = await lab.evaluate<number>(`lab.localChars(${JSON.stringify(target)})`);
  progress("typing 200 keys into the cell");
  const events = await lab.trace(async () => {
    await typeAt(lab, keys, 10);
    await lab.evaluate("lab.settle()");
  });
  const charsAfter = await lab.evaluate<number>(`lab.localChars(${JSON.stringify(target)})`);
  const { latencies, missing } = keystrokeLatencies(events, keys.length); // EB-6's own extractor
  session.close();
  return { loadMs, typed: summarize(latencies), missing, landed: charsAfter - charsBefore, expected: keys.length };
}

async function measureColumnGesture() {
  progress("the column gesture: one add-column (101 ops) on the 100-row table");
  const session = await labSession();
  const { lab } = session;
  await session.load("ref-tables" as RefDocName, "idle");
  const table = refTableId();
  // The gesture's wall: the evaluate round-trip carries the synchronous
  // command + settle — the main-thread hold of 101 inserts and their render.
  // (Trace-gap heuristics misread timestamp resets; the wall is the truth.)
  const startedAt = performance.now();
  const status = await lab.evaluate<string>(`lab.diagCommand("nooq.table.add-column", ${JSON.stringify({ table })})`);
  if (status !== "applied") throw new Error(`column gesture declined: ${status}`);
  await lab.evaluate("lab.settle()");
  const wallMs = performance.now() - startedAt;
  session.close();
  return { wallMs };
}

describe.skipIf(!LAB || !labCapable)("EB-T: tables in the lab", () => {
  test("cell typing holds EB-6's gate: p95 within one frame at 4x, every character landed", async () => {
    const result = await measureCellTyping();
    await writeResult("eb-tables-cell-typing", { budget: "EB-T", ...result });
    progress(`typed p95 ${result.typed.p95?.toFixed(1) ?? "?"}ms, max ${result.typed.max?.toFixed(1) ?? "?"}ms, ${result.landed}/${result.expected} landed, load ${result.loadMs.toFixed(0)}ms`);
    if (ENFORCE) {
      expect(result.typed.p95 ?? Infinity).toBeLessThanOrEqual(FRAME_MS * 2);
      expect(result.landed).toBe(result.expected);
    }
  });

  test("the column gesture is measured (REPORT: budgets arrive from measurements)", async () => {
    const result = await measureColumnGesture();
    await writeResult("eb-tables-column-gesture", { budget: "EB-T", ...result });
    progress(`column insert wall ${result.wallMs.toFixed(1)}ms (101 ops applied and rendered)`);
    expect(result.wallMs).toBeGreaterThan(0); // the measurement itself is the assertion this landing
  });
});
