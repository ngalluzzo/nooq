/**
 * EB-5: the caret is ready before anything else. The editor becomes
 * editable (focused, caret showing) in the frame it becomes visible,
 * without anyone clicking.
 */

import { describe, expect, test } from "bun:test";
import { FRAME_MS, summarize, writeResult } from "./harness.ts";
import { ENFORCE, LAB, labSession } from "./session.ts";

const SAMPLES = 5;

describe.skipIf(!LAB)("EB-5 time to editable", () => {
  test(
    "ref-small: editable within one frame of becoming visible, with fonts delayed 2s",
    async () => {
      const samples: Record<string, number | null>[] = [];
      let browser = "";
      let fontRequests = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const session = await labSession({ requests: { Font: 2000 } });
        browser = session.lab.browser;
        await session.load("ref-small");
        // Give the page's own observer its 240-frame window to see focus arrive.
        for (let waited = 0; waited < 4000; waited += 100) {
          const marks = await session.lab.evaluate<Record<string, number | null>>("lab.marks()");
          if (marks["lab:editable"] !== null) break;
          await Bun.sleep(100);
        }
        samples.push(await session.lab.evaluate("lab.marks()"));
        fontRequests = await session.lab.evaluate<number>("performance.getEntriesByType('resource').filter(e => /\\.(woff2?|ttf|otf)/.test(e.name)).length");
        session.close();
      }

      const editable = samples.filter((m) => m["lab:editable"] !== null);
      const gaps = editable.map((m) => m["lab:editable"]! - m["lab:visible"]!);
      const result = {
        budget: "EB-5",
        doc: "ref-small",
        browser,
        samples: SAMPLES,
        neverEditable: SAMPLES - editable.length,
        editableAfterVisibleMs: gaps.length ? summarize(gaps) : null,
        visibleMs: summarize(samples.map((m) => m["lab:visible"] ?? NaN)),
        editorEmitsMarks: samples.some((m) => m["nq:visible"] !== null || m["nq:editable"] !== null),
        fontRequests,
      };
      await writeResult("eb5-editable", result);
      console.log(JSON.stringify(result, null, 2));

      if (!ENFORCE) return;
      expect(result.neverEditable).toBe(0);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(FRAME_MS);
    },
    120_000,
  );
});
