/**
 * EB-7: remote changes never move the local caret or the viewport.
 *
 * 10,000 seeded remote transactions (inserts, text edits, deletes, moves
 * of other blocks), run inside the page so each one costs a render, not a
 * round trip. The writer's caret sits at the end of a block in the middle.
 *
 * Edits to the caret's own block are left out for now: with whole-block
 * text replacement (DM-4.3 v0) "the same characters" isn't defined. They
 * join the fuzz once the editor splices characters.
 */

import { describe, expect, test } from "bun:test";
import { writeResult } from "./harness.ts";
import { ENFORCE, LAB, labSession, rowSelector, labCapable } from "./session.ts";

const OPS = Number(process.env.NQ_LAB_EB7_OPS ?? 10_000);
/** EB-7: a fixed seed set, plus one fresh seed printed on failure. */
const SEEDS = [0xeb7, Math.floor(Math.random() * 2 ** 31)];

interface FuzzResult {
  applied: number;
  counts: { focus: number; selection: number; viewport: number };
  first: { op: number; kind: string; detail: string }[];
  seconds: number;
  blocksAtEnd: number;
}

describe.skipIf(!LAB || !labCapable)("EB-7 remote changes never move the caret or viewport", () => {
  for (const seed of SEEDS) {
    test(
      `ref-small, seed ${seed}: ${OPS} remote transactions, zero violations`,
      async () => {
        const session = await labSession();
        const { lab } = session;
        await session.load("ref-small");
        const ids = await lab.evaluate<string[]>("lab.blockIds()");
        const caret = ids[25]!;
        await lab.scrollTo(rowSelector(caret));
        await lab.click(rowSelector(caret));
        await lab.press("End");
        await lab.evaluate("lab.settle()");

        const fuzz = await lab.evaluate<FuzzResult>(`lab.fuzzRemote(${JSON.stringify({ seed, ops: OPS, caret })})`, 1_200_000);
        const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
        session.close();

        const total = fuzz.counts.focus + fuzz.counts.selection + fuzz.counts.viewport;
        const result = { budget: "EB-7", doc: "ref-small", browser: lab.browser, seed, ...fuzz, violations: total, pageHidden };
        await writeResult(`eb7-remote-${seed === SEEDS[0] ? "fixed" : "fresh"}`, result);
        console.log(JSON.stringify(result, null, 2));
        if (total > 0) console.error(`EB-7 failed with seed ${seed}; rerun it to reproduce.`);
        if (ENFORCE) expect(total).toBe(0);
      },
      1_500_000,
    );
  }
});
