/**
 * Standalone SVG files for places that can't load the theme: README badges,
 * slides, favicons, print. Colors are resolved from tokens.json at build time,
 * so the files never drift from the theme.
 */

import { resolveColor, type ThemeId, type Tokens } from "../tokens.ts";
import { BODY, fmt, HEIGHT, LETTER_X, oPath, pointsAttr, REST, STROKE, TAIL_TOP, TAIL_X, WIDTH } from "./geometry.ts";

interface Inks {
  letters: string;
  tail: string;
}

const attrs = `fill="none" stroke-width="${STROKE}" stroke-linejoin="round"`;

function file(viewBox: string, title: string, body: string, size?: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size ?? ""} role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    body,
    `</svg>`,
    "",
  ].join("\n");
}

function wordmarkBody({ letters, tail }: Inks): string {
  return [
    ...REST.letters.map((l) => `<path d="${l.d}" stroke="${letters}" ${attrs}/>`),
    `<polyline points="${pointsAttr([REST.piece.points[0]!, REST.piece.points.at(-1)!])}" stroke="${tail}" ${attrs}/>`,
  ].join("\n");
}

function markBody({ letters, tail }: Inks): string {
  return [
    `<path d="${oPath(LETTER_X[3]!)}" stroke="${letters}" ${attrs}/>`,
    `<polyline points="${pointsAttr([[TAIL_X, TAIL_TOP], [TAIL_X, HEIGHT]])}" stroke="${tail}" ${attrs}/>`,
  ].join("\n");
}

function inks(tokens: Tokens, theme: ThemeId): Inks {
  return { letters: resolveColor(tokens, "graphite", theme), tail: resolveColor(tokens, "ink", theme) };
}

/** Every logo file, by name. */
export function logoAssets(tokens: Tokens): Record<string, string> {
  const box = `0 0 ${WIDTH} ${fmt(HEIGHT)}`;
  const markX = LETTER_X[3]! - STROKE / 2;
  const markBox = `${markX} 0 ${BODY + STROKE} ${fmt(HEIGHT)}`;
  const graphite = resolveColor(tokens, "graphite", "light");

  // The app icon: the mark centered on a paper tile by its full height, so the bowl sits above center and the tail below.
  const tile = 200;
  const dx = (tile - (BODY + STROKE)) / 2 - markX;
  const dy = (tile - HEIGHT) / 2;
  const icon = [
    `<rect width="${tile}" height="${tile}" rx="44" fill="${resolveColor(tokens, "paper", "light")}"/>`,
    `<g transform="translate(${fmt(dx)} ${fmt(dy)})">`,
    markBody(inks(tokens, "light")),
    `</g>`,
  ].join("\n");

  return {
    "nooq-wordmark.svg": file(box, "nooq", wordmarkBody(inks(tokens, "light"))),
    "nooq-wordmark-dark.svg": file(box, "nooq", wordmarkBody(inks(tokens, "dark"))),
    "nooq-wordmark-mono.svg": file(box, "nooq", wordmarkBody({ letters: graphite, tail: graphite })),
    "nooq-mark.svg": file(markBox, "nooq", markBody(inks(tokens, "light"))),
    "nooq-icon.svg": file(`0 0 ${tile} ${tile}`, "nooq", icon),
  };
}
