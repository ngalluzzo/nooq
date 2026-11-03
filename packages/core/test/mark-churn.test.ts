import { describe, expect, test } from "bun:test";
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

import { runsOf } from "../src/digests.ts";
import { fingerprint } from "../src/digest.ts";

describe("0013: the canonical run form", () => {
  test("runsOf: merging, omission, ordering — minimal by construction", () => {
    const text = { s: "abcdefghij", marks: [["bold"], ["bold"], [], [], ["em"], [], ["em", "strong"], ["em", "strong"], [], []] };
    expect(runsOf(text)).toEqual([
      { marks: ["bold"], from: 0, to: 2 },
      { marks: ["em"], from: 4, to: 5 },
      { marks: ["em", "strong"], from: 6, to: 8 },
    ]);
    expect(runsOf({ s: "", marks: [] })).toEqual([]);
    expect(runsOf({ s: "plain", marks: [[], [], [], [], []] })).toEqual([]); // unmarked: the absence of runs
  });

  test("THE 0013 PROPERTY: content-equal marks derive the SAME digest", async () => {
    const a = { s: "hello world", marks: [["bold"], ["bold"], ["bold"], ["bold"], ["bold"], [], [], [], [], [], []] };
    // Same content, equivalent representation: duplicated sets, unsorted, extra empties
    const b = { s: "hello world", marks: [["bold", "bold"], ["bold"], ["bold"], ["bold"], ["bold"], [], [], [], undefined, [], []] as never };
    const digestA = await fingerprint({ s: a.s, runs: runsOf(a) });
    const digestB = await fingerprint({ s: b.s, runs: runsOf(b) });
    expect(digestA).toBe(digestB);
    // And different content differs
    const c = { s: "hello world", marks: [["em"], ["em"], [], [], [], [], [], [], [], [], []] };
    expect(await fingerprint({ s: c.s, runs: runsOf(c) })).not.toBe(digestA);
  });

  test("the size claim, asserted: the digest input shrinks ~600x on formatted text", async () => {
    const chars = 10_000;
    const s = "x".repeat(chars);
    const marks: string[][] = [];
    for (let i = 0; i < chars; i++) marks.push(i < 500 ? ["bold"] : []);
    const perChar = JSON.stringify({ s, marks });
    const runs = JSON.stringify({ s, runs: runsOf({ s, marks }) });
    // The string rides both forms verbatim; the claim is the OVERHEAD: the
    // per-char form pays ~33KB of mark arrays beside a 10KB string (4.3x
    // content); the run form pays one run (~50 bytes) — under 1% overhead.
    expect(runs.length).toBeLessThan(s.length * 1.01 + 100);
    expect(perChar.length).toBeGreaterThan(s.length * 3);
  });
});
