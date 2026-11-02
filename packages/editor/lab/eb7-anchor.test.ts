/** EB-7.2: a changed viewport anchor yields to the nearest unchanged block below it. */
import { describe, expect, test } from "bun:test";
import type { Op } from "@nooq/core";
import { writeResult } from "./harness.ts";
import { ENFORCE, LAB, labCapable, labSession, rowSelector } from "./session.ts";

interface Probe {
  focusedBlock: string | null;
  selection: [number, number] | null;
  anchorTop: number | null;
  scrollY: number;
}

describe.skipIf(!LAB || !labCapable)("EB-7 viewport anchor fallback", () => {
  for (const scenario of ["delete", "grow", "move", "delete-and-grow-next", "delete-at-start", "move-at-start", "delete-below-at-end", "shrink-below-at-end"] as const) {
    test(`remote ${scenario} preserves the unchanged viewport anchor`, async () => {
      const session = await labSession();
      const { lab } = session;
      try {
        await session.load("ref-small");
        const ids = await lab.evaluate<string[]>("lab.allBlockIds()");
        const caret = ids[25]!;
        await lab.scrollTo(rowSelector(caret));
        await lab.click(rowSelector(caret));
        await lab.evaluate(`lab.placeCaretAtEnd(${JSON.stringify(caret)})`);
        await lab.evaluate("lab.settle()");
        if (scenario.endsWith("at-start")) await lab.evaluate("window.scrollTo(0, 0)");
        if (scenario === "shrink-below-at-end") {
          // A text shrink avoids a tombstone/history row replacing the lost
          // height, so this case actually reaches the lower scroll bound.
          const grow: Op = { op: "textEdit", block: ids.at(-1)!, changes: [{ insert: "extra\n".repeat(4) }] };
          await lab.evaluate(`lab.remote(${JSON.stringify(grow)})`);
          await lab.evaluate("lab.settle()");
        }
        if (scenario.endsWith("at-end")) await lab.evaluate("window.scrollTo(0, document.scrollingElement.scrollHeight)");
        await lab.evaluate("lab.settle()");

        const anchor = await lab.evaluate<string | null>("lab.topVisibleBlock()");
        const anchorIndex = anchor === null ? -1 : ids.indexOf(anchor);
        const next = anchorIndex < 0 ? undefined : ids[anchorIndex + 1];
        const fallback = scenario.endsWith("at-end") ? anchor : anchorIndex < 0 ? undefined : ids[anchorIndex + (scenario === "delete-and-grow-next" ? 2 : 1)];
        if (!anchor || !fallback || anchor === caret || fallback === caret) throw new Error("No independent viewport fallback in the reference document");
        const probe = () => lab.evaluate<Probe>(`lab.probe(${JSON.stringify(fallback)})`);
        const before = await probe();
        if (before.focusedBlock !== caret || before.selection === null) throw new Error("The writer must have a native text selection before the remote edit");
        const lastLength = scenario === "shrink-below-at-end" ? await lab.evaluate<number>(`lab.textOf(${JSON.stringify(ids.at(-1))}).length`) : 0;
        const ops: Op[] = scenario === "grow"
          ? [{ op: "textEdit", block: anchor, changes: [{ insert: "\n" }] }]
          : scenario === "move" || scenario === "move-at-start"
            ? [{ op: "move", block: anchor, newParent: null, index: scenario === "move-at-start" ? 3 : 0 }]
            : scenario === "delete-and-grow-next"
              ? [{ op: "delete", block: anchor }, { op: "textEdit", block: next!, changes: [{ insert: "\n" }] }]
              : scenario === "delete-below-at-end"
                ? [{ op: "delete", block: ids.at(-1)! }]
              : scenario === "shrink-below-at-end"
                ? [{ op: "textEdit", block: ids.at(-1)!, changes: [{ delete: lastLength }, { insert: "x" }] }]
              : [{ op: "delete", block: anchor }];
        // One synchronous arrival batch: a roots change must not hide the
        // later edit when the surface chooses its unchanged fallback.
        await lab.evaluate(`(() => { for (const op of ${JSON.stringify(ops)}) lab.remote(op); })()`);
        await lab.evaluate("lab.settle()");
        const after = await probe();
        if (before.anchorTop === null || after.anchorTop === null) throw new Error("The unchanged fallback block is missing");
        const driftPx = after.anchorTop - before.anchorTop;
        const counts = {
          focus: Number(after.focusedBlock !== caret),
          selection: Number(JSON.stringify(after.selection) !== JSON.stringify(before.selection)),
          viewport: Number(Math.abs(driftPx) >= 1),
        };
        const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
        const violations = counts.focus + counts.selection + counts.viewport;
        const result = { budget: "EB-7", doc: "ref-small", browser: lab.browser, cpuThrottle: lab.cpuThrottle, scenario, anchor, fallback, caret, ops, before, after, driftPx, counts, violations, pageHidden };
        await writeResult(`eb7-anchor-${scenario}`, result);
        console.log(JSON.stringify(result, null, 2));
        // EB-2.1: a hidden page makes the run void, even in report mode.
        expect(pageHidden).toBe(0);
        if (ENFORCE) expect(violations).toBe(0);
        if (scenario.endsWith("at-start")) {
          await lab.evaluate("window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))");
          await lab.evaluate("lab.settle()");
          const released = await probe();
          // The missing content is retained only during remote pinning;
          // deliberate navigation releases that local space.
          expect(released.anchorTop).not.toBeNull();
          expect(released.anchorTop!).toBeLessThan(after.anchorTop);
        }
      } finally {
        session.close();
      }
    }, 60_000);
  }
});

describe.skipIf(!LAB || !labCapable)("EB-7 visible origin boundary", () => {
  for (const scenario of ["no-visible-origin", "offscreen-fallback"] as const) {
    test(scenario === "no-visible-origin" ? "no-visible-origin does not pin below-screen rows" : "visible changed origin retains an offscreen fallback", async () => {
      const session = await labSession();
      const { lab } = session;
      try {
        await session.load("ref-small");
        const ids = await lab.evaluate<string[]>("lab.allBlockIds()");
        const origin = ids[0]!, fallback = ids[1]!, caret = scenario === "no-visible-origin" ? origin : ids[3]!;
        if (scenario === "offscreen-fallback") {
          const grow: Op = { op: "textEdit", block: origin, changes: [{ insert: "line\n".repeat(300) }] };
          await lab.evaluate(`lab.remote(${JSON.stringify(grow)})`);
          await lab.evaluate("lab.settle()");
        }
        await lab.evaluate(`lab.selectText(${JSON.stringify(caret)}, 5, 12)`);
        await lab.evaluate("lab.settle()");
        if (scenario === "no-visible-origin") await lab.evaluate("(() => { document.getElementById('root').style.paddingTop = (window.innerHeight * 2) + 'px'; window.scrollTo(0, 0); })()");
        else await lab.evaluate("(() => { window.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })); window.scrollTo(0, window.innerHeight * 4); })()");
        await lab.evaluate("lab.settle()");
        if (scenario === "no-visible-origin") await lab.evaluate("window.scrollTo(0, 0)");
        const layout = await lab.evaluate<{ top: string | null; height: number; visible: number }>(`(() => {
          const live = new Set(lab.allBlockIds());
          const visible = [...document.querySelectorAll('[data-nq-block]:not([data-nq-ph])')].filter(row => {
            const r = row.getBoundingClientRect(); return live.has(row.getAttribute('data-nq-block')) && r.bottom > 0 && r.top < window.innerHeight;
          }).length;
          return { top: lab.topVisibleBlock(), height: window.innerHeight, visible };
        })()`);
        const before = await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(fallback)})`);
        const beforePins = await lab.evaluate<number>("lab.stats().pins");
        expect(before.focusedBlock).toBe(caret);
        expect(before.selection).toEqual([5, 12]);
        expect(before.anchorTop).not.toBeNull();
        expect(before.anchorTop!).toBeGreaterThanOrEqual(layout.height);
        if (scenario === "no-visible-origin") expect(layout.visible).toBe(0);
        else { expect(layout.visible).toBeGreaterThan(0); expect(layout.top).toBe(origin); }
        const op: Op = scenario === "no-visible-origin"
          ? { op: "textEdit", block: origin, changes: [{ insert: "\n" }] }
          : { op: "delete", block: origin };
        await lab.evaluate(`lab.remote(${JSON.stringify(op)})`);
        await lab.evaluate("lab.settle()");
        const after = await lab.evaluate<Probe>(`lab.probe(${JSON.stringify(fallback)})`);
        const stats = await lab.evaluate<{ lastAnchor: string | null; pins: number }>("lab.stats()");
        const pageHidden = await lab.evaluate<number>("lab.hiddenCount()");
        const expected = scenario === "no-visible-origin" ? [6, 13] : [5, 12];
        const driftPx = scenario === "no-visible-origin" ? after.scrollY - before.scrollY
          : before.anchorTop === null || after.anchorTop === null ? null : after.anchorTop - before.anchorTop;
        const viewport = scenario === "no-visible-origin"
          ? Number(layout.top !== null || stats.lastAnchor !== null || stats.pins !== beforePins || Math.abs(driftPx ?? Infinity) >= 1)
          : Number(driftPx === null || Math.abs(driftPx) >= 1 || stats.pins <= beforePins);
        const counts = { focus: Number(after.focusedBlock !== caret), selection: Number(JSON.stringify(after.selection) !== JSON.stringify(expected)), viewport };
        const result = { budget: "EB-7", scenario, browser: lab.browser, cpuThrottle: lab.cpuThrottle, origin, fallback, caret, op, layout, before, after, stats, beforePins, expected, driftPx,
          driftMeaning: scenario === "no-visible-origin" ? "scroll offset without a visible origin" : "unchanged offscreen fallback top", counts, pageHidden, violations: Object.values(counts).reduce((a, b) => a + b, 0) };
        await writeResult(`eb7-anchor-${scenario}`, result);
        console.log(JSON.stringify(result));
        expect(pageHidden).toBe(0);
        expect(result.violations).toBe(0);
      } finally { session.close(); }
    }, 60_000);
  }
});
