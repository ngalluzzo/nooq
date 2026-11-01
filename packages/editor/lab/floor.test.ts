/**
 * EB-2.4 (new): the rig floor. Input-creation→presented-frame for a BARE
 * textarea — no editor, no logic — under the lab's 4x CPU throttle. EB-6's
 * absolute budget is only meaningful above this floor; a budget below the
 * floor is unfalsifiable no matter how fast the editor is.
 *
 * Never enforces. Writes results/floor.json for EB-6 to cite.
 */

import { describe, test } from "bun:test";
import { keystrokeLatencies, openLab, summarize, writeResult } from "./harness.ts";
import { LAB, labCapable } from "./session.ts";

describe.skipIf(!LAB || !labCapable)("EB-2.4 rig floor", () => {
  test("bare textarea: input-to-frame with no editor at all", async () => {
    const lab = await openLab();
    await lab.open("about:blank");
    await lab.evaluate(`(() => {
      const area = document.createElement("textarea");
      area.style.cssText = "width:400px;height:100px;font:16px sans-serif";
      document.body.append(area);
      area.focus();
      window.__area = area;
    })()`);
    const keys = Array.from({ length: 200 }, (_, i) => "floor probe text "[i % 16]!);
    const start = performance.now();
    const events = await lab.trace(async () => {
      for (let i = 0; i < keys.length; i++) {
        const due = start + (i * 1000) / 10;
        const wait = due - performance.now();
        if (wait > 0) await Bun.sleep(wait);
        await lab.press(keys[i]!);
      }
    });
    const { latencies, missing, vsyncMs } = keystrokeLatencies(events, keys.length);
    if (latencies.length === 0) {
      console.log("[floor] no EventLatency slices; missing:", missing);
    }
    const result = {
      budget: "EB-2.4",
      what: "rig floor: bare textarea, no editor",
      browser: lab.browser,
      throttle: 4,
      samples: latencies.length,
      missing,
      vsyncMs,
      floorMs: summarize(latencies),
    };
    await writeResult("floor", result);
    console.log(JSON.stringify(result, null, 2));
    lab.close();
  }, 120_000);
});
