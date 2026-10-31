import { describe, expect, test } from "bun:test";
import { checkContrast, contrastRatio, CONTRAST_PAIRS, luminance } from "../src/contrast.ts";
import type { Tokens } from "../src/tokens.ts";

const tokens = (await Bun.file(new URL("../tokens.json", import.meta.url)).json()) as Tokens;

describe("contrastRatio", () => {
  test("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  test("is symmetric and accepts shorthand hex", () => {
    expect(contrastRatio("#2343d1", "#f7f8fa")).toBe(contrastRatio("#f7f8fa", "#2343d1"));
    expect(luminance("#fff")).toBe(luminance("#ffffff"));
  });

  test("rejects colors it cannot measure", () => {
    expect(() => luminance("#ffffff80")).toThrow();
    expect(() => luminance("red")).toThrow();
  });
});

describe("every promised pair is legible in every theme", () => {
  const results = checkContrast(tokens);

  test("the promise covers both themes and every text token", () => {
    expect(results.length).toBe(CONTRAST_PAIRS.length * 2);
    const textTokens = tokens.color.tokens.filter((t) => /text|graphite|^ink$|^stamp$|^on-|^peer-/.test(t.name)).map((t) => t.name);
    const promised = new Set(CONTRAST_PAIRS.map((p) => p.fg));
    expect(textTokens.filter((t) => !promised.has(t))).toEqual([]);
  });

  for (const r of results) {
    test(`${r.theme}: ${r.fg} on ${r.bg} ≥ ${r.min}:1`, () => {
      expect(r.ratio).toBeGreaterThanOrEqual(r.min);
    });
  }
});

describe("the focus ring", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: its ink ring and paper gap match the theme and hold 4.5:1 on every surface`, () => {
      const ring = tokens.shadow.tokens.find((t) => t.name === "focus-ring")!.value as Record<string, string>;
      const [gap, color] = [...ring[theme]!.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]);
      const resolve = (name: string) => {
        const v = tokens.color.tokens.find((t) => t.name === name)!.value as Record<string, string>;
        return v[theme]!;
      };
      expect(gap).toBe(resolve("paper"));
      expect(color).toBe(resolve("ink"));
      for (const bg of ["paper", "paper-raised", "paper-sunken", "ink-soft"]) {
        expect(contrastRatio(color!, resolve(bg))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
