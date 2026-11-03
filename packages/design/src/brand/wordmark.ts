/**
 * The wordmark and mark as live SVG, and the animation that plays the Move.
 * The animation is for brand surfaces only (site, first run, loading); never
 * inside the editor, where nothing may delay the caret (§3).
 */

import { svg } from "../dom.ts";
import {
  CARET,
  fmt,
  HEIGHT,
  logoFrame,
  pointsAttr,
  Q_STROKE,
  Q_WIDTH,
  Q_X,
  REST,
  STROKE,
  TAIL,
  TIMINGS,
  WIDTH,
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
  const ink = svg("path", { class: "nq-logo-ink", pathLength: "1", ...stroke });
  const piece = svg("polyline", { class: "nq-logo-piece", ...stroke });
  const caret = svg("rect", { class: "nq-logo-caret", y: String(CARET.top), width: String(CARET.width), height: String(CARET.height), opacity: "0" });
  const el = frameSvg(`0 0 ${WIDTH} ${fmt(HEIGHT)}`, props, ...letters, ink, piece, caret);
  renderWordmarkFrame(el, REST);
  return el;
}

/** The mark is the same inked q that ends the wordmark. */
export function mark(props: LogoProps = {}): SVGSVGElement {
  return frameSvg(
    `${Q_X} 0 ${Q_WIDTH} ${fmt(HEIGHT)}`,
    props,
    svg("path", { class: "nq-logo-letter is-ink", d: REST.letters[3]!.d, ...stroke, "stroke-width": Q_STROKE }),
    svg("polyline", { class: "nq-logo-piece is-moved", points: pointsAttr(TAIL), ...stroke, "stroke-width": Q_STROKE }),
  );
}

/** Draw one frame into a wordmark made by `wordmark()`. */
export function renderWordmarkFrame(el: SVGSVGElement, frame: LogoFrame): void {
  const letters = el.querySelectorAll<SVGPathElement>(".nq-logo-letter");
  frame.letters.forEach((l, i) => {
    letters[i]!.setAttribute("d", l.d);
    letters[i]!.setAttribute("opacity", l.visible ? "1" : "0");
  });
  const { weight, ink } = frame.q ?? { weight: STROKE, ink: 0 };
  const q = letters[3]!;
  const bowlInk = el.querySelector(".nq-logo-ink")!;
  q.setAttribute("stroke-width", fmt(weight));
  q.classList.toggle("is-ink", ink === 1);
  bowlInk.setAttribute("visibility", frame.letters[3]!.visible && ink > 0 && ink < 1 ? "visible" : "hidden");
  bowlInk.setAttribute("d", frame.letters[3]!.d);
  bowlInk.setAttribute("stroke-width", fmt(weight));
  bowlInk.setAttribute("stroke-dasharray", `${ink} ${1 - ink}`);
  bowlInk.setAttribute("stroke-dashoffset", String(ink / 2));
  const piece = el.querySelector<SVGPolylineElement>(".nq-logo-piece")!;
  piece.setAttribute("points", pointsAttr(frame.piece.points));
  piece.setAttribute("opacity", frame.piece.visible ? "1" : "0");
  piece.setAttribute("stroke-width", fmt(weight));
  piece.classList.toggle("is-moved", frame.piece.moved);
  piece.style.setProperty("--nq-logo-piece-ink", `${(frame.piece.ink ?? 1) * 100}%`);
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

const active = new WeakMap<SVGSVGElement, WordmarkAnimation>();

/** Play the Move on a wordmark. Whatever happens, it ends at rest: the logo is never left half-drawn. */
export function animateWordmark(el: SVGSVGElement, { timing = "hero", reducedMotion = prefersReducedMotion() }: AnimateOptions = {}): WordmarkAnimation {
  active.get(el)?.cancel();
  if (reducedMotion) {
    renderWordmarkFrame(el, REST);
    return { finished: Promise.resolve(), cancel: () => {} };
  }

  const t = typeof timing === "string" ? TIMINGS[timing] : timing;
  let frameId = 0;
  let stopped = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const rest = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frameId);
    active.delete(el);
    renderWordmarkFrame(el, REST);
    done();
  };

  let start: number | undefined;
  const step = (now: number) => {
    start ??= now;
    const ms = now - start;
    if (ms >= t.total) return rest();
    renderWordmarkFrame(el, logoFrame(ms, t));
    frameId = requestAnimationFrame(step);
  };
  renderWordmarkFrame(el, logoFrame(0, t));
  const animation = { finished, cancel: rest };
  active.set(el, animation);
  frameId = requestAnimationFrame(step);
  return animation;
}
