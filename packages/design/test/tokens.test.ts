import { describe, expect, test } from "bun:test";
import { aliasTarget, declaredValue, resolveColor, THEMES, tokensToCss, type Tokens } from "../src/tokens.ts";

const root = new URL("..", import.meta.url);
const tokens = (await Bun.file(new URL("tokens.json", root)).json()) as Tokens;
const tokensCss = await Bun.file(new URL("src/tokens.css", root)).text();
const themeCss = await Bun.file(new URL("src/nooq.css", root)).text();

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const LENGTH = /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em|%))$/;
const DURATION = /^\d+ms$/;
const INTEGER = /^\d+$/;

/** The single nq cascade layer, unwrapped (comments and all) for structural checks. */
const unwrap = (css: string) => css.replace(/@layer[^{]*\{/, "").replace(/\}\s*$/, "");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").trimStart();

const lists = {
  color: tokens.color.tokens,
  spacing: tokens.spacing.tokens,
  radius: tokens.radius.tokens,
  size: tokens.size.tokens,
  shadow: tokens.shadow.tokens,
  highlight: tokens.highlight.tokens,
  motion: tokens.motion.tokens,
  layer: tokens.layer.tokens,
  editor: tokens.editor.tokens,
};

describe("tokens.json", () => {
  test("light is the first theme, so tokens missing a theme inherit light", () => {
    expect(tokens.color.themes.map((t) => t.id)).toEqual(["light", "dark"]);
  });

  test("names are valid and unique across every family but type", () => {
    const names = Object.values(lists).flatMap((l) => l.map((t) => t.name));
    for (const n of names) expect(n).toMatch(NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every token says where it is used", () => {
    for (const t of Object.values(lists).flat()) expect(t.usage.length).toBeGreaterThan(10);
  });

  for (const token of tokens.color.tokens) {
    test(`color ${token.name} is a hex or an alias of an existing color, in every theme`, () => {
      for (const theme of THEMES) {
        const v = declaredValue(token, theme);
        const target = aliasTarget(v);
        if (target) expect(tokens.color.tokens.some((t) => t.name === target)).toBe(true);
        else expect(v).toMatch(HEX);
        expect(resolveColor(tokens, token.name, theme)).toMatch(HEX);
      }
    });
  }

  test("lengths are plain CSS lengths", () => {
    for (const t of [...lists.spacing, ...lists.radius, ...lists.size, ...lists.highlight, ...lists.editor]) expect(t.value).toMatch(LENGTH);
  });

  test("motion tokens are durations; layer tokens are plain integers", () => {
    for (const t of lists.motion) expect(t.value).toMatch(DURATION);
    for (const t of lists.layer) expect(t.value).toMatch(INTEGER);
  });

  test("the layer scale only grows: presence < toolbar < overlay < dialog", () => {
    const z = (name: string) => parseInt(lists.layer.find((t) => t.name === name)!.value, 10);
    expect(z("layer-presence")).toBeLessThan(z("layer-toolbar"));
    expect(z("layer-toolbar")).toBeLessThan(z("layer-overlay"));
    expect(z("layer-overlay")).toBeLessThan(z("layer-dialog"));
  });

  test("the spacing scale only grows", () => {
    const px = lists.spacing.map((t) => parseFloat(t.value));
    expect(px).toEqual([...px].sort((a, b) => a - b));
  });

  test("control heights grow small to medium to handle", () => {
    const height = (name: string) => parseFloat(lists.size.find((t) => t.name === name)!.value);
    expect(height("control-sm")).toBeLessThan(height("control-md"));
    expect(height("control-handle")).toBeLessThan(height("control-md"));
  });

  test("type styles name a declared family and use valid sizes", () => {
    const styles = tokens.type.groups.flatMap((g) => g.styles.map((s) => ({ ...s, family: s.family ?? g.family })));
    expect(new Set(styles.map((s) => s.name)).size).toBe(styles.length);
    for (const s of styles) {
      expect(Object.keys(tokens.type.families)).toContain(s.family);
      expect(s.fontSize).toMatch(LENGTH);
      expect(s.lineHeight).toMatch(LENGTH);
      expect(s.fontWeight).toBeGreaterThanOrEqual(100);
      expect(s.fontWeight).toBeLessThanOrEqual(900);
    }
  });

  test("document text keeps a comfortable measure: body line height ≥ 1.5", () => {
    const body = tokens.type.groups.flatMap((g) => g.styles).find((s) => s.name === "doc-body")!;
    expect(parseFloat(body.lineHeight) / parseFloat(body.fontSize)).toBeGreaterThanOrEqual(1.5);
  });

  test("font stacks end in a generic family", () => {
    for (const stack of Object.values(tokens.type.families)) expect(stack).toMatch(/(serif|sans-serif|monospace)$/);
  });
});

describe("tokens.css", () => {
  test("is up to date with tokens.json (run `bun run tokens`)", () => {
    expect(tokensCss).toBe(tokensToCss(tokens));
  });

  test("ships inside one nq cascade layer, so host styles win without specificity fights", () => {
    expect(stripComments(tokensCss)).toMatch(/^@layer nq \{/);
    expect(stripComments(themeCss)).toMatch(/^@layer nq \{/);
    expect(unwrap(tokensCss).trimEnd().endsWith("}")).toBe(true);
  });

  test("every --nq-* custom property the theme uses is defined", () => {
    const defined = new Set([...tokensCss.matchAll(/(--nq-[\w-]+):/g)].map((m) => m[1]));
    // --nq-peer is set inline per writer; --nq-x/--nq-y carry the popover's
    // computed position, the same component-set channel.
    defined.add("--nq-peer");
    defined.add("--nq-x");
    defined.add("--nq-y");
    const used = new Set([...themeCss.matchAll(/var\((--nq-[\w-]+)/g)].map((m) => m[1]!));
    const missing = [...used].filter((u) => !defined.has(u));
    expect(missing).toEqual([]);
  });

  test("control heights and highlight washes are tokens, not literals", () => {
    // Icon-size literals (the actor mark's 10px, the sr clip's 1px) wait on the icon-size token family below.
    const iconLiterals = new Set(["height: 1px", "height: 10px"]);
    for (const declaration of themeCss.match(/(?<![\w-])height: [^;}]+/g) ?? []) {
      if (/\dpx/.test(declaration) && !iconLiterals.has(declaration)) expect(declaration).toMatch(/^height: var\(--nq-/);
    }
    expect(themeCss).not.toMatch(/\d+(?:\.\d+)?%, transparent/);
    expect(themeCss.match(/var\(--nq-highlight-peer\)/g)?.length).toBeGreaterThanOrEqual(7);
  });

  test("durations and z-indexes come from tokens, not literals", () => {
    expect(themeCss).not.toMatch(/animation:[^;]*\d+m?s/);
    expect(themeCss).not.toMatch(/z-index: ?\d/);
    expect(themeCss).toContain("animation: nq-blink calc(var(--nq-blink) * 2) steps(1) infinite");
    expect(themeCss).toContain("animation: nq-fade var(--nq-fade) ease-out");
    expect(themeCss).toContain("z-index: var(--nq-layer-presence)");
    expect(themeCss).toContain("z-index: var(--nq-layer-overlay)");
  });

  test("never sets color-scheme on :root, so a host page keeps its own", () => {
    for (const block of unwrap(tokensCss).matchAll(/^:root \{([^}]*)\}/gm)) expect(block[1]).not.toContain("color-scheme");
  });

  test("redeclares aliases in every theme block, so a dark subtree recolors its caret", () => {
    for (const selector of ['[data-nq-theme="dark"]', '[data-nq-theme="light"]']) {
      const block = tokensCss.slice(tokensCss.indexOf(selector));
      expect(block.slice(0, block.indexOf("}"))).toContain("--nq-caret: var(--nq-ink);");
    }
  });

  test("the theme stylesheet styles nothing outside .nq-* classes", () => {
    const selectors = unwrap(themeCss)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[^{]+\{[^}]*\{[^}]*\}\s*\}/g, "")
      .replace(/@media[^{]+\{/g, "")
      .match(/[^{}]+(?=\{)/g)!
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of selectors) expect(s).toMatch(/^\.nq-/);
  });
});
