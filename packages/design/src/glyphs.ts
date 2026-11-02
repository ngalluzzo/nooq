/**
 * The system's only drawn glyphs, in currentColor. No icon set, no emoji.
 *
 * Two vocabularies, one grid: the suggestion states (DM-6.2, with their
 * fills) and the chrome glyphs (close, more, chevron, undo, redo, history,
 * access, verified, model, warning, stop, export) that the toolbar, notice,
 * popover and form controls are drawn from. All geometric; a state glyph
 * never doubles as a chrome glyph and vice versa, so a shape keeps its meaning.
 */

import { svg } from "./dom.ts";

export type GlyphName =
  | "fresh" | "stale" | "conflicted" | "accepted" | "rejected" | "local" | "offline" | "grip"
  | "close" | "more" | "chevron" | "undo" | "redo" | "history" | "access" | "verified" | "model" | "warning" | "stop" | "export";

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

  // Chrome. Same 12-unit grid, same stroke, so they sit together at any size.
  close: () => [svg("path", { d: "M3 3l6 6M9 3l-6 6", ...stroke })],
  more: () => [2.5, 6, 9.5].map((x) => svg("circle", { cx: String(x), cy: "6", r: "1.5", fill: "currentColor" })),
  chevron: () => [svg("path", { d: "M2.5 4.5L6 8l3.5-3.5", ...stroke })],
  undo: () => [svg("path", { d: "M9.5 9.5V6A3.5 3.5 0 0 0 6 2.5H2.5", ...stroke }), svg("path", { d: "M4.5 0.8L2.3 2.5l2.2 1.7", ...stroke })],
  redo: () => [svg("path", { d: "M2.5 9.5V6A3.5 3.5 0 0 1 6 2.5h3.5", ...stroke }), svg("path", { d: "M7.5 0.8l2.2 1.7-2.2 1.7", ...stroke })],
  history: () => [svg("circle", { ...ring, r: "4.25" }), svg("path", { d: "M6 3.75V6l1.75 1.25", ...stroke })],
  access: () => [svg("circle", { cx: "3.75", cy: "6", r: "2", ...stroke }), svg("path", { d: "M5.75 6h4M8.25 6v1.75M10 6v1.75", ...stroke })],
  verified: () => [svg("circle", { ...ring, r: "4.25" }), svg("path", { d: "M4.1 6.2l1.5 1.5 2.7-3", ...stroke })],
  model: () => [svg("rect", { x: "2.25", y: "2.25", width: "7.5", height: "7.5", ...stroke }), svg("path", { d: "M2.75 9.25L9.25 2.75", ...stroke })],
  warning: () => [svg("path", { d: "M6 1.75L11 10H1z", ...stroke }), svg("path", { d: "M6 5v2.4", ...stroke }), svg("circle", { cx: "6", cy: "9", r: "0.35", fill: "currentColor", stroke: "none" })],
  stop: () => [svg("rect", { x: "3", y: "3", width: "6", height: "6", fill: "currentColor" })],
  // Export: one arrow leaving the document into a tray — the header's quiet verb beside Access.
  export: () => [svg("path", { d: "M6 1.75v6", ...stroke }), svg("path", { d: "M3.4 5.4L6 8l2.6-2.6", ...stroke }), svg("path", { d: "M2.25 10.25h7.5", ...stroke })],
};

export function glyph(name: GlyphName): SVGElement {
  if (name === "grip") {
    const dots = [3, 7].flatMap((x) => [3, 8, 13].map((y) => svg("circle", { cx: String(x), cy: String(y), r: "1.25", fill: "currentColor" })));
    return svg("svg", { class: "nq-glyph", viewBox: "0 0 10 16", width: "10", height: "16", "aria-hidden": "true", "data-glyph": name }, dots);
  }
  return svg("svg", { class: "nq-glyph", viewBox: "0 0 12 12", width: "12", height: "12", "aria-hidden": "true", "data-glyph": name }, SHAPES[name]());
}
