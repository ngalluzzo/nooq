/**
 * The nooq logo, as geometry.
 *
 * n, o, o and q share one counter. The wordmark is drawn around that single
 * module: every letter is the same rounded centerline at the same stroke.
 * The animation types "oooo", then performs a Move (DM-4.4): the base of the
 * first o detaches, which leaves an n, travels under the word intact, and
 * unrolls into the tail of the last o, which makes it a q. The piece keeps
 * its length the whole way; the q's tail is exactly what the n gave up.
 *
 * Everything here is pure, so every frame can be tested without a DOM.
 * Units are the wordmark's own: the x-height is 100, the baseline is y = 100.
 */

export type Point = readonly [number, number];

/** Monoline stroke width. */
export const STROKE = 18;
/** Corner radius of the shared centerline. */
export const RADIUS = 29;
/** Centerline width of every letter. */
export const BODY = 74;
/** Centerline top and bottom: the outer edges land on 0 and the baseline. */
export const TOP = STROKE / 2;
export const BOTTOM = 100 - STROKE / 2;
export const BASELINE = 100;
/** Outer letter width plus a 14-unit gap. */
export const PITCH = BODY + STROKE + 14;
/** Centerline left edge of each letter. */
export const LETTER_X: readonly number[] = [0, 1, 2, 3].map((i) => i * PITCH + STROKE / 2);
/** Outer width of the wordmark. */
export const WIDTH = 3 * PITCH + BODY + STROKE;

/** The base of an o: left corner, flat bottom, right corner. Its length is the q's tail. */
export const PIECE_LENGTH = Math.PI * RADIUS + (BODY - 2 * RADIUS);
/** The q's tail runs down the right side of its bowl from where the top corner ends. */
export const TAIL_X = LETTER_X[3]! + BODY;
export const TAIL_TOP = TOP + RADIUS;
/** Outer height of the wordmark, descender included. */
export const HEIGHT = TAIL_TOP + PIECE_LENGTH;
/** How far the n's stems grow to reach the baseline once the base lets go. */
export const STEM_GROWTH = BASELINE - (BOTTOM - RADIUS);
/** The detached piece drops this far below the stems' new ends. */
export const RELEASE_GAP = 12;

const r = RADIUS;
/** Numbers in SVG output: three decimals at most. */
export const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** A closed o around the shared counter. */
export function oPath(x: number): string {
  const [L, R, T, B] = [x, x + BODY, TOP, BOTTOM].map(fmt);
  return (
    `M${fmt(x + r)} ${T}H${fmt(x + BODY - r)}A${r} ${r} 0 0 1 ${R} ${fmt(TOP + r)}` +
    `V${fmt(BOTTOM - r)}A${r} ${r} 0 0 1 ${fmt(x + BODY - r)} ${B}H${fmt(x + r)}` +
    `A${r} ${r} 0 0 1 ${L} ${fmt(BOTTOM - r)}V${fmt(TOP + r)}A${r} ${r} 0 0 1 ${fmt(x + r)} ${T}Z`
  );
}

/** The top of an o with straight sides `growth` units long below the corners: an n once growth = STEM_GROWTH. */
export function archPath(x: number, growth: number): string {
  const end = fmt(BOTTOM - r + growth);
  return (
    `M${fmt(x)} ${end}V${fmt(TOP + r)}A${r} ${r} 0 0 1 ${fmt(x + r)} ${fmt(TOP)}` +
    `H${fmt(x + BODY - r)}A${r} ${r} 0 0 1 ${fmt(x + BODY)} ${fmt(TOP + r)}V${end}`
  );
}

const CORNER = (Math.PI * r) / 2;
const FLAT = BODY - 2 * r;

/** A point on the piece at arc length u, for an o whose centerline starts at x. u = 0 is the top of the left side. */
export function piecePoint(x: number, u: number): Point {
  if (u < CORNER) {
    const a = u / r;
    return [x + r - r * Math.cos(a), BOTTOM - r + r * Math.sin(a)];
  }
  if (u < CORNER + FLAT) return [x + r + (u - CORNER), BOTTOM];
  const a = (u - CORNER - FLAT) / r;
  return [x + BODY - r + r * Math.sin(a), BOTTOM - r + r * Math.cos(a)];
}

/** Unit tangent of the piece at arc length u. */
export function pieceTangent(u: number): Point {
  if (u < CORNER) {
    const a = u / r;
    return [Math.sin(a), Math.cos(a)];
  }
  if (u < CORNER + FLAT) return [1, 0];
  const a = (u - CORNER - FLAT) / r;
  return [Math.cos(a), -Math.sin(a)];
}

export interface Timing {
  /** When each of the four o's is typed, in ms. Uneven on purpose: people don't type on a grid. */
  keys: readonly [number, number, number, number];
  /** The first o lets go of its base. */
  release: readonly [number, number];
  /** The piece travels, intact, under the word. */
  travel: readonly [number, number];
  /** Docked at the last o, it unrolls into the tail. */
  unroll: readonly [number, number];
  /** The caret parks after the q and blinks twice; absent for the loader. */
  ready?: readonly [number, number];
  total: number;
}

export const TIMINGS = {
  /** Site hero and first run. */
  hero: { keys: [0, 240, 420, 640], release: [1050, 1450], travel: [1450, 2150], unroll: [2150, 2800], ready: [2850, 3400], total: 3400 },
  /** Loading states: the same choreography, no parked caret. */
  loader: { keys: [0, 150, 270, 410], release: [600, 850], travel: [850, 1300], unroll: [1300, 1750], total: 1800 },
} as const satisfies Record<string, Timing>;

export type TimingName = keyof typeof TIMINGS;

export type Phase = "typing" | "beat" | "release" | "travel" | "unroll" | "ready" | "rest";

export interface LogoFrame {
  phase: Phase;
  /** Path data for the four letters; letter 0 is the arch, the others are o's. */
  letters: readonly { visible: boolean; d: string }[];
  /** The moving piece as a centerline polyline. `moved` once it has let go: it is drawn in ink from then on. */
  piece: { visible: boolean; moved: boolean; points: readonly Point[] };
  caret: { visible: boolean; x: number };
}

/** Caret geometry: it spans the centerline x-height, just right of the last letter typed. */
export const CARET = { width: 4, top: TOP, height: BOTTOM - TOP, gap: 14 } as const;
export const caretAfter = (letter: number) => LETTER_X[letter]! + BODY + CARET.gap;
/** Where the caret parks after the q: clear of the tail. */
export const CARET_READY_X = TAIL_X + STROKE / 2 + 12;
const CARET_START_X = LETTER_X[0]! - STROKE / 2 - 10;

/** The piece's travel path for its top-left end: under the word, then straight up into the q's stem. */
export const TRAVEL_PATH: readonly Point[] = [
  [LETTER_X[0]!, BOTTOM - RADIUS + STEM_GROWTH + RELEASE_GAP],
  [185, 159],
  [TAIL_X, 169],
  [TAIL_X, TAIL_TOP],
];

const SAMPLES = 80;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const out = (t: number) => 1 - (1 - t) ** 3;
const progress = (ms: number, [a, b]: readonly [number, number]) => clamp((ms - a) / (b - a));

function bezier(s: number, path: readonly Point[]): Point {
  const [p0, p1, p2, p3] = path as readonly [Point, Point, Point, Point];
  const m = 1 - s;
  const [a, b, c, d] = [m * m * m, 3 * m * m * s, 3 * m * s * s, s * s * s];
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** The piece while it travels: rigid, its top-left end on the travel path. */
function rigidPiece(anchor: Point): Point[] {
  const origin = piecePoint(0, 0);
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const [x, y] = piecePoint(0, (PIECE_LENGTH * i) / SAMPLES);
    return [anchor[0] + x - origin[0], anchor[1] + y - origin[1]] as const;
  });
}

/**
 * The piece unrolling from the dock: the first u0 units hang straight down the
 * stem; the rest keeps its shape, rotated so it stays tangent at the joint.
 */
function unrollingPiece(s: number): Point[] {
  const u0 = s * PIECE_LENGTH;
  const [tx, ty] = pieceTangent(Math.min(u0, PIECE_LENGTH - 1e-9));
  const turn = Math.PI / 2 - Math.atan2(ty, tx);
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const joint = piecePoint(0, u0);
  const us = Array.from({ length: SAMPLES + 1 }, (_, i) => (PIECE_LENGTH * i) / SAMPLES);
  if (!us.includes(u0)) us.push(u0);
  us.sort((a, b) => a - b);
  return us.map((u) => {
    if (u <= u0) return [TAIL_X, TAIL_TOP + u] as const;
    const [x, y] = piecePoint(0, u);
    const [vx, vy] = [x - joint[0], y - joint[1]];
    return [TAIL_X + vx * cos - vy * sin, TAIL_TOP + u0 + vx * sin + vy * cos] as const;
  });
}

/** The logo at `ms` into the animation. Past the end, or at Infinity, it is the wordmark at rest. */
export function logoFrame(ms: number, timing: Timing = TIMINGS.hero): LogoFrame {
  const { keys } = timing;
  const shown = keys.map((k) => ms >= k);
  const lastShown = shown.lastIndexOf(true);

  const released = progress(ms, timing.release);
  const growth = STEM_GROWTH * inOut(released);
  const drop = growth + RELEASE_GAP * inOut(released);
  const travelled = inOut(progress(ms, timing.travel));
  const unrolled = out(progress(ms, timing.unroll));

  let points: Point[];
  if (unrolled > 0) points = unrollingPiece(unrolled);
  else if (travelled > 0) points = rigidPiece(bezier(travelled, TRAVEL_PATH));
  else points = rigidPiece([LETTER_X[0]!, BOTTOM - RADIUS + drop]);

  // A blink in the beat after "oooo"; two in the ready window.
  let caretVisible = ms < timing.release[0] && !(ms > keys[3] + 180 && ms < Math.min(timing.release[0], keys[3] + 330));
  let caretX = lastShown < 0 ? CARET_START_X : caretAfter(lastShown);
  if (timing.ready && ms >= timing.ready[0] && ms < timing.ready[1]) {
    const q = progress(ms, timing.ready);
    caretVisible = q < 0.45 || q > 0.7;
    caretX = CARET_READY_X;
  }

  const phase: Phase =
    ms <= keys[3] ? "typing"
    : ms < timing.release[0] ? "beat"
    : ms < timing.travel[0] ? "release"
    : ms < timing.travel[1] ? "travel"
    : ms < timing.unroll[1] ? "unroll"
    : timing.ready && ms < timing.ready[1] ? "ready"
    : "rest";

  return {
    phase,
    letters: [
      { visible: shown[0]!, d: archPath(LETTER_X[0]!, growth) },
      ...[1, 2, 3].map((i) => ({ visible: shown[i]!, d: oPath(LETTER_X[i]!) })),
    ],
    piece: { visible: shown[0]!, moved: ms >= timing.release[0], points },
    caret: { visible: caretVisible, x: caretX },
  };
}

/** The wordmark at rest: n, o, o, q with the tail in place. */
export const REST: LogoFrame = logoFrame(Infinity);

export const pointsAttr = (points: readonly Point[]) => points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");

/** Polyline length; the piece's is conserved in every frame. */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}
