import { describe, test } from "bun:test";
import { canonicalJson } from "@nooq/core";
import { freezeInPlace } from "@nooq/core";

/** The churn shapes: heavy formatting fragments runs; measure where it hurts. */
const text = (chars: number, runs: number): { s: string; marks: string[][] } => {
  let s = "";
  const marks: string[][] = [];
  const per = Math.max(1, Math.floor(chars / runs));
  for (let r = 0; r < Math.ceil(chars / per); r++) {
    const names = r % 2 === 0 ? ["bold"] : r % 3 === 0 ? ["bold", "italic"] : [];
    const str = "x".repeat(Math.min(per, chars - s.length));
    s += str;
    for (let i = 0; i < str.length; i++) marks.push(names); // shared per run (readText's EB-8 shape)
  }
  return { s, marks };
};

describe("DM-10.2 mark churn: measured", () => {
  test("canonical json / clone / freeze by fragmentation (10k chars)", () => {
    for (const runs of [10, 1_000, 10_000]) {
      const t = text(10_000, runs);
      const block = { id: "b", type: "nooq.paragraph/v1", fields: {}, text: t, children: [], attribution: { created: { actor: "a" }, fields: {} } };

      let t0 = performance.now();
      const json = canonicalJson(block);
      const jsonMs = performance.now() - t0;

      t0 = performance.now();
      const cloned = structuredClone(block);
      const cloneMs = performance.now() - t0;

      t0 = performance.now();
      freezeInPlace(cloned);
      const freezeMs = performance.now() - t0;

      // distinct array identities after clone (sharing broken?)
      const distinct = new Set(t.marks.map(m => m)).size;
      const clonedDistinct = new Set((cloned as typeof block).text!.marks.map(m => m)).size;

      console.log(
        `runs=${String(runs).padStart(5)} | distinct=${String(distinct).padStart(5)} | cloned-distinct=${String(clonedDistinct).padStart(5)}` +
        ` | canonical ${(json.length / 1024).toFixed(0)}KB in ${jsonMs.toFixed(1)}ms | clone ${cloneMs.toFixed(1)}ms | freeze ${freezeMs.toFixed(1)}ms`,
      );
    }
  });
});
