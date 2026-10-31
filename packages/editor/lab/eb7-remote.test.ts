/**
 * EB-7: remote changes never move the local caret or the viewport.
 *
 * First version: a seeded smoke fuzz of 200 remote transactions on
 * ref-small (EB-7 asks for 10,000; this proves the harness first).
 * Edits to the caret's own block are left out: with whole-block text
 * replacement (DM-4.3 v0) "the same characters" isn't defined yet.
 */

import { describe, expect, test } from "bun:test";
import type { Op } from "@nooq/core";
import { writeResult } from "./harness.ts";
import { LAB, labSession, rowSelector } from "./session.ts";

const OPS = 200;
const SEED = 0xeb7;

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Probe {
  focusedBlock: string | null;
  selection: [number, number] | null;
  anchorTop: number | null;
  scrollY: number;
}

describe.skipIf(!LAB)("EB-7 remote changes never move the caret or viewport", () => {
  test(
    `ref-small: ${OPS} seeded remote transactions, zero violations`,
    async () => {
      const session = await labSession();
      const { lab } = session;
      await session.load("ref-small");
      const rand = random(SEED);
      const ids = await lab.evaluate<string[]>("lab.blockIds()");
      const caret = ids[25]!;

      async function placeCaret(): Promise<void> {
        await lab.scrollTo(rowSelector(caret));
        await lab.click(rowSelector(caret));
        await lab.press("End");
        await lab.evaluate("lab.settle()");
      }
      await placeCaret();

      const violations: { op: number; kind: "focus" | "selection" | "viewport"; detail: string }[] = [];
      let n = 0;
      for (let i = 0; i < OPS; i++) {
        const before = await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(caret)})`);
        const anchor = await lab.evaluate<string | null>("lab.topVisibleBlock()");
        const anchorBefore = anchor ? await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(anchor)})`) : null;
        const order = await lab.evaluate<string[]>("lab.blockIds()");
        const others = order.filter((id) => id !== caret && id !== anchor);
        const pick = () => others[Math.floor(rand() * others.length)]!;
        const roll = rand();
        let op: Op;
        let touchesAnchor = false;
        if (roll < 0.35) {
          op = { op: "insert", block: { id: crypto.randomUUID(), type: "nooq.paragraph/v1", fields: {}, text: { s: `remote ${i}`, marks: Array.from({ length: `remote ${i}`.length }, () => []) }, children: [], attribution: { created: { actor: "human:remote" }, fields: {} } }, parent: null, index: Math.floor(rand() * (order.length + 1)) };
        } else if (roll < 0.6) {
          const block = pick();
          op = { op: "textEdit", block, replace: { s: `edited ${i}`, marks: Array.from({ length: `edited ${i}`.length }, () => []) } };
        } else if (roll < 0.8) {
          op = { op: "delete", block: pick() };
        } else {
          op = { op: "move", block: pick(), newParent: null, index: Math.floor(rand() * order.length) };
        }
        if (anchor && "block" in op && op.block === anchor) touchesAnchor = true;

        await lab.evaluate(`lab.remote(${JSON.stringify(op)})`);
        await lab.evaluate("lab.settle()");
        n++;

        const after = await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(caret)})`);
        if (after.focusedBlock !== caret) {
          violations.push({ op: i, kind: "focus", detail: `${op.op}: focus moved from the caret's block to ${after.focusedBlock ?? "nothing"}` });
          await placeCaret(); // restore so the other invariants keep being tested
          continue;
        }
        if (JSON.stringify(after.selection) !== JSON.stringify(before.selection)) {
          violations.push({ op: i, kind: "selection", detail: `${op.op}: selection ${JSON.stringify(before.selection)} → ${JSON.stringify(after.selection)}` });
        }
        if (anchor && anchorBefore?.anchorTop != null && !touchesAnchor) {
          const anchorAfter = await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(anchor)})`);
          if (anchorAfter.anchorTop != null && Math.abs(anchorAfter.anchorTop - anchorBefore.anchorTop) >= 1) {
            violations.push({ op: i, kind: "viewport", detail: `${op.op}: top block moved ${Math.round(anchorAfter.anchorTop - anchorBefore.anchorTop)}px` });
          }
        }
      }
      session.close();

      const count = (kind: string) => violations.filter((v) => v.kind === kind).length;
      const result = {
        budget: "EB-7",
        doc: "ref-small",
        browser: lab.browser,
        seed: SEED,
        remoteTransactions: n,
        violations: { total: violations.length, focus: count("focus"), selection: count("selection"), viewport: count("viewport") },
        firstViolations: violations.slice(0, 5),
      };
      await writeResult("eb7-remote", result);
      console.log(JSON.stringify(result, null, 2));
      expect(violations).toEqual([]);
    },
    600_000,
  );
});
