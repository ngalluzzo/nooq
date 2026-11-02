/** EB-7.1: directed native ranges and the selected block's lifecycle. */
import { describe, expect, test } from "bun:test";
import type { Op } from "@nooq/core";
import { writeResult } from "./harness.ts";
import { LAB, labCapable, labSession } from "./session.ts";

describe.skipIf(!LAB || !labCapable)("EB-7 native selections", () => {
  for (const scenario of ["insert-before", "insert-start", "insert-end", "delete-before", "delete-repeated", "delete-inside", "delete-covered", "backward-delete", "backward-marks", "move-first", "move-last", "backward-move", "delete-block", "delete-first-block", "delete-last-block"] as const) {
    test(scenario, async () => {
      const session = await labSession();
      const { lab } = session;
      try {
        await session.load("ref-small");
        const ids = await lab.evaluate<string[]>("lab.allBlockIds()");
        const block = scenario === "delete-first-block" ? ids[0]! : scenario === "delete-last-block" ? ids.at(-1)! : ids[25]!;
        expect(await lab.evaluate(`lab.scrollToBlock(${JSON.stringify(block)})`)).toBe("landed");
        if (scenario === "delete-repeated") {
          const length = await lab.evaluate<number>(`lab.textOf(${JSON.stringify(block)}).length`);
          await lab.evaluate(`lab.remote(${JSON.stringify({ op: "textEdit", block, changes: [{ delete: length }, { insert: "a".repeat(24) }] })})`);
          await lab.evaluate("lab.settle()");
        }
        const backward = scenario.startsWith("backward");
        const selection = backward ? [12, 5] : [5, 12];
        await lab.evaluate(`lab.selectText(${JSON.stringify(block)}, ${selection[0]}, ${selection[1]})`);
        await lab.evaluate("lab.settle()");
        const beforeOrder = await lab.evaluate<string[]>("lab.allBlockIds()");
        const top = await lab.evaluate<string | null>("lab.topVisibleBlock(lab.allBlockIds())");
        const anchor = top === block ? beforeOrder[beforeOrder.indexOf(block) + 1] : top;
        const before = await lab.evaluate<any>(`lab.probe(${JSON.stringify(anchor)})`);
        expect(before.selection).toEqual(selection);
        let expectedBlock = block, expected = [...selection];
        let op: Op;
        if (scenario.startsWith("insert")) {
          const at = scenario === "insert-start" ? 5 : scenario === "insert-end" ? 12 : 1;
          op = { op: "textEdit", block, changes: [{ retain: at }, { insert: "XY" }] };
          expected = scenario === "insert-end" ? [5, 12] : [7, 14];
        } else if (scenario.includes("move")) op = { op: "move", block, newParent: null, index: scenario === "move-first" ? 0 : ids.length - 1 };
        else if (scenario.includes("block")) {
          op = { op: "delete", block };
          const at = ids.indexOf(block);
          expectedBlock = ids[at + 1] ?? ids[at - 1]!;
          const offset = ids[at + 1] ? 0 : await lab.evaluate<number>(`lab.textOf(${JSON.stringify(expectedBlock)}).length`);
          expected = [offset, offset];
        } else if (scenario === "backward-marks") op = { op: "textEdit", block, changes: [{ retain: 5 }, { retain: 7, setMarks: ["strong"] }] };
        else {
          const at = (scenario === "delete-before" || scenario === "delete-repeated") ? 1 : scenario === "delete-covered" ? 3 : 7;
          op = { op: "textEdit", block, changes: [{ retain: at }, { delete: scenario === "delete-covered" ? 12 : 2 }] };
          expected = (scenario === "delete-before" || scenario === "delete-repeated") ? [3, 10] : scenario === "delete-covered" ? [3, 3] : backward ? [10, 5] : [5, 10];
        }
        await lab.evaluate(`lab.remote(${JSON.stringify(op)})`);
        await lab.evaluate("lab.settle()");
        const after = await lab.evaluate<any>(`lab.probe(${JSON.stringify(anchor)})`);
        const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
        const drift = before.anchorTop === null || after.anchorTop === null ? null : after.anchorTop - before.anchorTop;
        const counts = { focus: Number(after.focusedBlock !== expectedBlock), selection: Number(JSON.stringify(after.selection) !== JSON.stringify(expected)), viewport: Number(drift === null || Math.abs(drift) >= 1) };
        const result = { budget: "EB-7", scenario, browser: lab.browser, cpuThrottle: lab.cpuThrottle, block, expectedBlock, selection, expected, op, before, after, driftPx: drift, counts, pageHidden, violations: Object.values(counts).reduce((a, b) => a + b, 0) };
        await writeResult(`eb7-selection-${scenario}`, result);
        console.log(JSON.stringify(result));
        expect(pageHidden).toBe(0);
        expect(result.violations).toBe(0);
      } finally { session.close(); }
    }, 60_000);
  }
});
