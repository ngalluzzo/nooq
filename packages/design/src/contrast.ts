/**
 * WCAG 2 contrast, and the pairs this system promises to keep legible.
 *
 * Every text token's usage note in tokens.json names the grounds it reads on.
 * CONTRAST_PAIRS is that promise as data, so tests can hold every theme to it.
 */

import { resolveColor, THEMES, type ThemeId, type Tokens } from "./tokens.ts";

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #rgb or #rrggbb color. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not an opaque hex color: ${hex}`);
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** 4.5 for body text, 3 for control borders, focus rings and marks that carry meaning (WCAG 1.4.3, 1.4.11). */
export interface ContrastPair {
  fg: string;
  bg: string;
  min: 4.5 | 3;
}

const text = (fg: string, grounds: string[]): ContrastPair[] => grounds.map((bg) => ({ fg, bg, min: 4.5 }));
const mark = (fg: string, grounds: string[]): ContrastPair[] => grounds.map((bg) => ({ fg, bg, min: 3 }));

const PAPERS = ["paper", "paper-raised", "paper-sunken"];
const PEERS = ["peer-teal", "peer-violet", "peer-green", "peer-sepia", "peer-magenta", "peer-slate"];

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...text("graphite", [...PAPERS, "ink-soft", "pencil-soft", "stamp-soft"]),
  ...text("graphite-muted", [...PAPERS, "pencil-soft", "ink-soft"]),
  ...text("ink", ["paper", "paper-raised", "ink-soft"]),
  ...text("pencil-text", ["paper", "paper-raised", "paper-sunken", "pencil-soft"]),
  ...text("stamp", ["paper", "paper-raised", "stamp-soft"]),
  ...PEERS.flatMap((p) => [...text(p, ["paper", "paper-raised"]), ...text("on-peer", [p])]),
  ...text("on-ink", ["ink-fill"]),
  ...text("on-pencil", ["pencil"]),
  ...text("on-stamp", ["stamp"]),
  ...mark("rule-strong", ["paper", "paper-raised"]),
  ...mark("ink", PAPERS),
  ...mark("pencil-text", PAPERS),
  ...mark("machine", PAPERS),
  ...PEERS.flatMap((p) => mark(p, PAPERS)),
];

export interface ContrastResult extends ContrastPair {
  theme: ThemeId;
  ratio: number;
  pass: boolean;
}

export function checkContrast(tokens: Tokens, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): ContrastResult[] {
  return THEMES.flatMap((theme) =>
    pairs.map((pair) => {
      const ratio = contrastRatio(resolveColor(tokens, pair.fg, theme), resolveColor(tokens, pair.bg, theme));
      return { ...pair, theme, ratio, pass: ratio >= pair.min };
    }),
  );
}
