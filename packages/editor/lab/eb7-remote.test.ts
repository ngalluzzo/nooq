/** EB-7: every remote arrival preserves native selection and the unchanged viewport anchor. */
import { describe, expect, test } from "bun:test";
import { writeResult } from "./harness.ts";
import { ENFORCE, LAB, TEXT_MODE, labSession, rowSelector, labCapable } from "./session.ts";

const OPS = Number(process.env.NQ_LAB_EB7_OPS ?? 10_000);
if (!Number.isInteger(OPS) || OPS < 1) throw new Error("NQ_LAB_EB7_OPS must be a positive integer");
const freshSeed = Number(process.env.NQ_LAB_EB7_FRESH_SEED ?? Math.floor(Math.random() * 2 ** 31));
if (!Number.isInteger(freshSeed) || freshSeed < 0 || freshSeed >= 2 ** 31) throw new Error("NQ_LAB_EB7_FRESH_SEED must be an unsigned 31-bit integer");
const SEEDS = [0xeb7, freshSeed];
const RUN_MS = 2_100_000; // Bounded driver headroom; EB-7 is an invariant, not a latency budget.
interface FuzzResult {
  applied: number;
  anchorChanges: number;
  viewportChecks: { anchored: number; noVisibleOrigin: number; noRenderedFallback: number };
  coverage: Record<string, number>;
  counts: { focus: number; selection: number; viewport: number; convergence: number };
  first: { op: number; kind: string; detail: string }[];
  seconds: number;
  blocksAtEnd: number;
}

describe.skipIf(!LAB || !labCapable)("EB-7 remote changes never move the caret or viewport", () => {
  for (const [index, seed] of SEEDS.entries()) {
    const seedKind = index === 0 ? "fixed" : "fresh";
    test(`ref-small, ${seedKind} seed ${seed}: ${OPS} remote transactions, zero violations`, async () => {
      const session = await labSession();
      const { lab } = session;
      const startedAt = new Date().toISOString();
      try {
        console.log(`[EB-7] ${lab.backend}/${TEXT_MODE}, ${seedKind} seed ${seed}: starting ${OPS} remote transactions`);
        await session.load("ref-small");
        const ids = await lab.evaluate<string[]>("lab.allBlockIds()");
        const caret = ids[25]!;
        expect(await lab.evaluate(`lab.scrollToBlock(${JSON.stringify(caret)})`)).toBe("landed");
        await lab.click(rowSelector(caret));
        await lab.evaluate(`lab.placeCaretAtEnd(${JSON.stringify(caret)})`);
        await lab.evaluate("lab.settle()");
        const fuzz = await lab.evaluate<FuzzResult>(`lab.fuzzRemote(${JSON.stringify({ seed, ops: OPS, caret })})`, RUN_MS);
        const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
        const violations = Object.values(fuzz.counts).reduce((a, b) => a + b, 0);
        const result = { budget: "EB-7", workloadVersion: 5, doc: "ref-small", browser: lab.browser, cpuThrottle: lab.cpuThrottle, seed, seedKind, startedAt, finishedAt: new Date().toISOString(), ...fuzz, violations, pageHidden };
        await writeResult(`eb7-remote-${seedKind}`, result);
        console.log(JSON.stringify(result, null, 2));
        if (violations) console.error(`EB-7 failed with seed ${seed}; NQ_LAB_EB7_FRESH_SEED=${seed} reproduces it.`);
        expect(fuzz.applied).toBe(OPS);
        expect(Object.values(fuzz.viewportChecks).reduce((a, b) => a + b, 0)).toBe(OPS);
        expect(pageHidden).toBe(0);
        // Missing coverage makes a measurement invalid, including report mode.
        if (OPS >= 32) {
          expect(fuzz.viewportChecks.anchored).toBeGreaterThan(0);
          for (const kind of ["insert", "edit", "caretInsert", "delete", "restore", "move", "marks", "caretMarks", "otherMarks", "concurrentPairs", "aFirst", "bFirst", "charDelete", "deleteBefore", "deleteInside", "deleteCovered", "deleteOther", "caretMove", "caretDelete", "caretConcurrentPairs", "selectionForward", "selectionBackward", "selectionCollapsed", "emptyUpdates"]) expect(fuzz.coverage[kind]).toBeGreaterThan(0);
          expect(fuzz.coverage.concurrentMoves).toBe(2 * fuzz.coverage.concurrentPairs!);
          expect(fuzz.coverage.aFirst! + fuzz.coverage.bFirst!).toBe(fuzz.coverage.concurrentPairs!);
          expect(["insert", "edit", "caretInsert", "delete", "restore", "move", "marks", "concurrentMoves", "charDelete", "caretMove", "caretDelete"].reduce((n, kind) => n + fuzz.coverage[kind]!, 0)).toBe(fuzz.applied);
          expect(fuzz.coverage.selectionForward! + fuzz.coverage.selectionBackward! + fuzz.coverage.selectionCollapsed!).toBe(fuzz.applied);
          expect(fuzz.coverage.caretMarks! + fuzz.coverage.otherMarks!).toBe(fuzz.coverage.marks!);
        }
        if (ENFORCE) expect(violations).toBe(0);
      } finally { session.close(); }
    }, RUN_MS + 300_000);
  }
});
