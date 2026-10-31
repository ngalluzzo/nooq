/**
 * The system's only drawn glyphs, in currentColor. No icon set, no emoji.
 */

import { svg } from "./dom.ts";

export type GlyphName = "fresh" | "stale" | "conflicted" | "accepted" | "rejected" | "local" | "offline" | "grip";

const stroke = { stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" };
const ring = { cx: "6", cy: "6", r: "3.25", fill: "none", stroke: "currentColor", "stroke-width": "1.5" };

const SHAPES: Record<Exclude<GlyphName, "grip">, () => SVGElement[]> = {
  fresh: () => [svg("circle", { cx: "6", cy: "6", r: "3.5", fill: "currentColor" })],
  stale: () => [svg("circle", ring), svg("path", { d: "M6 2.75a3.25 3.25 0 0 1 0 6.5z", fill: "currentColor" })],
  conflicted: () => [svg("path", { d: "M3.25 3.25l5.5 5.5M8.75 3.25l-5.5 5.5", ...stroke })],
  accepted: () => [svg("path", { d: "M2.5 6.4l2.4 2.4 4.6-5", ...stroke })],
  rejected: () => [svg("path", { d: "M3 6h6", ...stroke })],
  local: () => [svg("circle", ring)],
  offline: () => [svg("circle", { ...ring, "stroke-dasharray": "2 2" })],
};

export function glyph(name: GlyphName): SVGElement {
  if (name === "grip") {
    const dots = [3, 7].flatMap((x) => [3, 8, 13].map((y) => svg("circle", { cx: String(x), cy: String(y), r: "1.25", fill: "currentColor" })));
    return svg("svg", { class: "nq-glyph", viewBox: "0 0 10 16", width: "10", height: "16", "aria-hidden": "true", "data-glyph": name }, dots);
  }
  return svg("svg", { class: "nq-glyph", viewBox: "0 0 12 12", width: "12", height: "12", "aria-hidden": "true", "data-glyph": name }, SHAPES[name]());
}
