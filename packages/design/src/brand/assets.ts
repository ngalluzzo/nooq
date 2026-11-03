/**
 * Standalone SVG files for places that can't load the theme: README badges,
 * slides, favicons, print. Colors are resolved from tokens.json at build time,
 * so the files never drift from the theme.
 */

import { resolveColor, type ThemeId, type Tokens } from "../tokens.ts";
import { fmt, HEIGHT, pointsAttr, Q_STROKE, Q_WIDTH, Q_X, REST, STROKE, TAIL, WIDTH } from "./geometry.ts";

interface Inks {
  letters: string;
  q: string;
}

const attrs = (width: number) => `fill="none" stroke-width="${width}" stroke-linejoin="round"`;

function file(viewBox: string, title: string, body: string, size?: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size ?? ""} role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    body,
    `</svg>`,
    "",
  ].join("\n");
}

function wordmarkBody({ letters, q }: Inks): string {
  return [
    ...REST.letters.slice(0, 3).map((l) => `<path d="${l.d}" stroke="${letters}" ${attrs(STROKE)}/>`),
    markBody(q),
  ].join("\n");
}

function markBody(ink: string): string {
  return [
    `<path d="${REST.letters[3]!.d}" stroke="${ink}" ${attrs(Q_STROKE)}/>`,
    `<polyline points="${pointsAttr(TAIL)}" stroke="${ink}" ${attrs(Q_STROKE)}/>`,
  ].join("\n");
}

function inks(tokens: Tokens, theme: ThemeId): Inks {
  return { letters: resolveColor(tokens, "graphite", theme), q: resolveColor(tokens, "ink", theme) };
}

/** Every logo file, by name. */
export function logoAssets(tokens: Tokens): Record<string, string> {
  const box = `0 0 ${WIDTH} ${fmt(HEIGHT)}`;
  const markBox = `${Q_X} 0 ${Q_WIDTH} ${fmt(HEIGHT)}`;
  const light = inks(tokens, "light");

  // The app icon: the mark centered on a paper tile by its full height, so the bowl sits above center and the tail below.
  const tile = 200;
  const dx = (tile - Q_WIDTH) / 2 - Q_X;
  const dy = (tile - HEIGHT) / 2;
  const icon = [
    `<rect width="${tile}" height="${tile}" rx="44" fill="${resolveColor(tokens, "paper", "light")}"/>`,
    `<g transform="translate(${fmt(dx)} ${fmt(dy)})">`,
    markBody(light.q),
    `</g>`,
  ].join("\n");

  return {
    "nooq-wordmark.svg": file(box, "nooq", wordmarkBody(light)),
    "nooq-wordmark-dark.svg": file(box, "nooq", wordmarkBody(inks(tokens, "dark"))),
    "nooq-wordmark-mono.svg": file(box, "nooq", wordmarkBody({ letters: light.letters, q: light.letters })),
    "nooq-mark.svg": file(markBox, "nooq", markBody(light.q)),
    "nooq-icon.svg": file(`0 0 ${tile} ${tile}`, "nooq", icon),
  };
}
