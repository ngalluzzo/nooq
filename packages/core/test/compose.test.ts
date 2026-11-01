import { describe, expect, test } from "bun:test";
import { applyTextChanges, composeTextChanges, type RenderedText, type TextChange } from "../src/index.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKS = ["bold", "code", "italic"];

/** A random, valid change list over a text of this length. */
function randomChanges(rng: () => number, length: number): TextChange[] {
  const changes: TextChange[] = [];
  let position = 0;
  const marks = () => MARKS.filter(() => rng() < 0.3);
  while (rng() < 0.8) {
    const roll = rng();
    const room = length - position;
    if (roll < 0.3 && room > 0) {
      const n = 1 + Math.floor(rng() * room);
      changes.push(rng() < 0.3 ? { retain: n, setMarks: rng() < 0.2 ? null : marks() } : { retain: n });
      position += n;
    } else if (roll < 0.6 && room > 0) {
      const n = 1 + Math.floor(rng() * Math.min(room, 4));
      changes.push({ delete: n });
      position += n;
    } else {
      const insert = "xyz w".slice(0, 1 + Math.floor(rng() * 4));
      changes.push(rng() < 0.5 ? { insert } : { insert, marks: marks() });
    }
  }
  return changes;
}

function randomText(rng: () => number): RenderedText {
  const s = "hello world".slice(0, Math.floor(rng() * 12));
  return { s, marks: s.split("").map(() => MARKS.filter(() => rng() < 0.3)) };
}

describe("composeTextChanges (DM-14.3)", () => {
  test("composing equals applying in sequence, for random texts and changes", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = mulberry32(seed);
      const base = randomText(rng);
      const first = randomChanges(rng, base.s.length);
      const middle = applyTextChanges(base, first);
      const second = randomChanges(rng, middle.s.length);
      const composed = composeTextChanges(first, second);
      expect({ seed, result: applyTextChanges(base, composed) }).toEqual({ seed, result: applyTextChanges(middle, second) });
    }
  });

  test("a typed word composes to one insert; typed-then-erased text vanishes", () => {
    const keystrokes: TextChange[][] = [[{ retain: 3 }, { insert: "w" }], [{ retain: 4 }, { insert: "o" }], [{ retain: 5 }, { insert: "r" }], [{ retain: 6 }, { insert: "d" }]];
    expect(keystrokes.reduce(composeTextChanges)).toEqual([{ retain: 3 }, { insert: "word" }]);
    expect(composeTextChanges([{ retain: 3 }, { insert: "wo" }], [{ retain: 4 }, { delete: 1 }])).toEqual([{ retain: 3 }, { insert: "w" }]);
    expect(composeTextChanges([{ retain: 3 }, { insert: "w" }], [{ retain: 3 }, { delete: 1 }])).toEqual([]);
  });
});
