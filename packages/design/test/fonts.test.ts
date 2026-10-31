import { describe, expect, test } from "bun:test";
import { buildFontsCss, FALLBACK_NAMES, SUBSETS } from "../scripts/fonts.ts";
import type { Tokens } from "../src/tokens.ts";

const root = new URL("..", import.meta.url);
const fontsCss = await Bun.file(new URL("src/fonts.css", root)).text();
const tokens = (await Bun.file(new URL("tokens.json", root)).json()) as Tokens;
const faces = [...fontsCss.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face/g)].map((m) => m[1]!);

describe("fonts.css", () => {
  test("is up to date with the fontsource packages (run `bun run fonts`)", async () => {
    expect(fontsCss).toBe(await buildFontsCss());
  });

  test("declares only Latin and Latin Extended, so inlining bundlers embed only those", () => {
    expect(faces.length).toBe(10);
    for (const name of faces) expect(SUBSETS.some((s) => name.includes(`-${s}-`))).toBe(true);
    expect(fontsCss).not.toMatch(/cyrillic|greek|vietnamese/);
  });

  test("references the fonts by package path, which Bun and Vite both resolve", () => {
    expect(fontsCss).not.toContain("url(./files/");
    for (const m of fontsCss.matchAll(/url\("([^"]+)"\)/g)) expect(m[1]).toMatch(/^@fontsource-variable\/[\w-]+\/files\/[\w-]+\.woff2$/);
  });

  test("every face swaps in, and every family has a metric-matched fallback (EB-8)", () => {
    expect(fontsCss.match(/font-display: swap/g)?.length).toBe(10);
    for (const name of FALLBACK_NAMES) {
      const block = fontsCss.slice(fontsCss.indexOf(`font-family: "${name}"`));
      expect(block.slice(0, block.indexOf("}"))).toMatch(/size-adjust: [\d.]+%/);
    }
  });

  test("each token font stack puts its fallback right after the real face", () => {
    const stacks = Object.values(tokens.type.families);
    FALLBACK_NAMES.forEach((name, i) => {
      const families = stacks[i]!.split(",").map((s) => s.trim().replace(/"/g, ""));
      expect(families[1]).toBe(name);
    });
  });
});
