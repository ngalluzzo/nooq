/**
 * The wordmark and mark as live SVG, and the animation that plays the Move.
 * The animation is for brand surfaces only (site, first run, loading); never
 * inside the editor, where nothing may delay the caret (§3).
 */

import { svg } from "../dom.ts";
import {
  BODY,
  CARET,
  fmt,
  HEIGHT,
  LETTER_X,
  logoFrame,
  pointsAttr,
  REST,
  STROKE,
  TAIL_TOP,
  TAIL_X,
  TIMINGS,
  WIDTH,
  oPath,
  type LogoFrame,
  type Timing,
  type TimingName,
} from "./geometry.ts";

export interface LogoProps {
  /** Accessible name. */
  title?: string;
  /** One ink for everything, from CSS `color`: for print, embossing, single-color contexts. */
  mono?: boolean;
}

const stroke = { "stroke-width": String(STROKE), "stroke-linejoin": "round", fill: "none" };

function frameSvg(viewBox: string, { title = "nooq", mono }: LogoProps, ...children: SVGElement[]): SVGSVGElement {
  return svg(
    "svg",
    { class: ["nq-logo", mono && "nq-logo-mono"], viewBox, role: "img", "aria-label": title, overflow: "visible" },
    svg("title", {}, title),
    ...children,
  ) as SVGSVGElement;
}

/** The wordmark. At rest unless animated with `animateWordmark`. */
export function wordmark(props: LogoProps = {}): SVGSVGElement {
  const letters = REST.letters.map((l) => svg("path", { class: "nq-logo-letter", d: l.d, ...stroke }));
  const piece = svg("polyline", { class: "nq-logo-piece is-moved", points: pointsAttr(REST.piece.points), ...stroke });
  const caret = svg("rect", { class: "nq-logo-caret", y: String(CARET.top), width: String(CARET.width), height: String(CARET.height), opacity: "0" });
  const el = frameSvg(`0 0 ${WIDTH} ${fmt(HEIGHT)}`, props, ...letters, piece, caret);
  el.dataset.phase = REST.phase;
  return el;
}

/** The mark: the q alone, its tail in ink. Collapse the wordmark and this is what remains. */
export function mark(props: LogoProps = {}): SVGSVGElement {
  const x = LETTER_X[3]! - STROKE / 2;
  return frameSvg(
    `${x} 0 ${BODY + STROKE} ${fmt(HEIGHT)}`,
    props,
    svg("path", { class: "nq-logo-letter", d: oPath(LETTER_X[3]!), ...stroke }),
    svg("polyline", { class: "nq-logo-piece is-moved", points: pointsAttr([[TAIL_X, TAIL_TOP], [TAIL_X, HEIGHT]]), ...stroke }),
  );
}

/** Draw one frame into a wordmark made by `wordmark()`. */
export function renderWordmarkFrame(el: SVGSVGElement, frame: LogoFrame): void {
  const letters = el.querySelectorAll<SVGPathElement>(".nq-logo-letter");
  frame.letters.forEach((l, i) => {
    letters[i]!.setAttribute("d", l.d);
    letters[i]!.setAttribute("opacity", l.visible ? "1" : "0");
  });
  const piece = el.querySelector(".nq-logo-piece")!;
  piece.setAttribute("points", pointsAttr(frame.piece.points));
  piece.setAttribute("opacity", frame.piece.visible ? "1" : "0");
  piece.classList.toggle("is-moved", frame.piece.moved);
  const caret = el.querySelector(".nq-logo-caret")!;
  caret.setAttribute("x", String(frame.caret.x));
  caret.setAttribute("opacity", frame.caret.visible ? "1" : "0");
  el.dataset.phase = frame.phase;
}

export interface AnimateOptions {
  timing?: TimingName | Timing;
  /** Defaults to the viewer's `prefers-reduced-motion`. When true, the wordmark is shown at rest and nothing moves. */
  reducedMotion?: boolean;
}

export interface WordmarkAnimation {
  /** Resolves when the wordmark is at rest, whether it finished or was cancelled. */
  finished: Promise<void>;
  /** Stop now and show the wordmark at rest. */
  cancel(): void;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Play the Move on a wordmark. Whatever happens, it ends at rest: the logo is never left half-drawn. */
export function animateWordmark(el: SVGSVGElement, { timing = "hero", reducedMotion = prefersReducedMotion() }: AnimateOptions = {}): WordmarkAnimation {
  const t = typeof timing === "string" ? TIMINGS[timing] : timing;
  let frameId = 0;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const rest = () => {
    cancelAnimationFrame(frameId);
    renderWordmarkFrame(el, REST);
    done();
  };

  if (reducedMotion) {
    rest();
    return { finished, cancel: () => {} };
  }

  let start: number | undefined;
  const step = (now: number) => {
    start ??= now;
    const ms = now - start;
    if (ms >= t.total) return rest();
    renderWordmarkFrame(el, logoFrame(ms, t));
    frameId = requestAnimationFrame(step);
  };
  renderWordmarkFrame(el, logoFrame(0, t));
  frameId = requestAnimationFrame(step);
  return { finished, cancel: rest };
}
