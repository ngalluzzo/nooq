/**
 * EB-8: load to first editable. Gate: three consecutive cold loads of
 * ref-huge (10,000 blocks) at the rig's 4x profile, EVERY load reaching
 * lab:editable within 1,000 ms (EXPERIENCE-BUDGETS EB-8, accepted by the
 * product owner 2026-11-01). Windowing is the mechanism; the gate is
 * flat-in-document-size by construction.
 */
import { describe, expect, test } from "bun:test";
import { ENFORCE, LAB, labSession, labCapable } from "./session.ts";

const run = LAB && labCapable;

describe.skipIf(!run)("EB-8 load to first editable", () => {
  test("ref-huge: three cold loads, every one editable <= 1000ms at 4x", async () => {
    const { lab, load, close } = await labSession({ throttle: 4 });
    const loads: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        await load("ref-huge");
        let ms = -1;
        for (let poll = 0; poll < 130; poll++) {
          ms = await lab.evaluate<number>("performance.getEntriesByName('lab:editable')[0]?.startTime ?? -1");
          if (ms >= 0) break;
          await Bun.sleep(1000);
        }
        loads.push(ms);
      }
    } finally {
      close();
    }
    console.log("EB-8 loads (ms):", JSON.stringify(loads));
    if (ENFORCE) {
      expect(loads.length).toBe(3);
      for (const ms of loads) expect(ms).toBeGreaterThanOrEqual(0);
      expect(Math.max(...loads)).toBeLessThanOrEqual(1000);
    }
  }, 600_000);
});
