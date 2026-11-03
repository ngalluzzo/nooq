/**
 * The ink transfer, as pure geometry. The first o gives up its base. The
 * stroke straightens, follows a rounded track into the last o, and inks the
 * bowl as it becomes a q. The moving centerline keeps its length.
 */

export type Point = readonly [number, number];

export const STROKE = 18;
export const RADIUS = 29;
export const BODY = 74;
export const TOP = STROKE / 2;
export const BOTTOM = 100 - STROKE / 2;
export const BASELINE = BOTTOM + STROKE / 2;
export const PITCH = BODY + STROKE + 14;
export const LETTER_X = [9, 115, 221, 327] as const;
export const WIDTH = LETTER_X[3] + BODY + STROKE / 2;

const Q_LEFT = 328;
export const Q_STROKE = 20;
export const Q_RADIUS = 18;
export const Q_WIDTH = 66 + Q_STROKE;
export const Q_X = Q_LEFT - Q_STROKE / 2;
export const TAIL_X = Q_LEFT + 66;
export const TAIL_TOP = Q_STROKE / 2 + Q_RADIUS;
const CORNER = Math.PI * RADIUS / 2;
const FLAT = BODY - 2 * RADIUS;
export const PIECE_LENGTH = 2 * CORNER + FLAT;
export const HEIGHT = TAIL_TOP + PIECE_LENGTH;

export const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const fraction = (v: number, start: number, end: number) => v < start ? 0 : v >= end ? 1 : (v - start) / (end - start);
const ramp = (v: number, start: number, end: number) => smooth(fraction(v, start, end));

function bowlPath(left: number, right: number, top: number, bottom: number, radius: number): string {
  const [l, r, t, b, a, hi, lo, innerLeft, innerRight] = [
    left, right, top, bottom, radius, top + radius, bottom - radius, left + radius, right - radius,
  ].map(fmt);
  const arc = `A${a} ${a} 0 0 0 `;
  // Start on the right stem, where ink enters the bowl and spreads in both directions.
  return `M${r} ${lo}V${hi}${arc}${innerRight} ${t}H${innerLeft}${arc}${l} ${hi}` +
    `V${lo}${arc}${innerLeft} ${b}H${innerRight}${arc}${r} ${lo}Z`;
}

export function oPath(x: number): string {
  return bowlPath(x, x + BODY, TOP, BOTTOM, RADIUS);
}

const LAST_O_RIGHT = LETTER_X[3] + BODY;
const DOCK_SHIFT = LAST_O_RIGHT - TAIL_X;

function qPath(settle: number): string {
  return bowlPath(
    mix(LETTER_X[3], Q_LEFT, settle), LAST_O_RIGHT - DOCK_SHIFT * settle,
    mix(TOP, Q_STROKE / 2, settle), mix(BOTTOM, BASELINE - Q_STROKE / 2, settle),
    mix(RADIUS, Q_RADIUS, settle),
  );
}

function archPath(end: number): string {
  const x = LETTER_X[0];
  return `M${x} ${fmt(end)}V${TOP + RADIUS}A${RADIUS} ${RADIUS} 0 0 1 ${x + RADIUS} ${TOP}` +
    `H${x + BODY - RADIUS}A${RADIUS} ${RADIUS} 0 0 1 ${x + BODY} ${TOP + RADIUS}V${fmt(end)}`;
}

export interface Timing {
  /** When each starting o appears, in ms. */
  keys: readonly [number, number, number, number];
  release: readonly [number, number];
  travel: readonly [number, number];
  /** The stroke turns upward and inks the bowl. */
  unroll: readonly [number, number];
  ready?: readonly [number, number];
  /** Custom timings show a caret by default. */
  caret?: boolean;
  total: number;
}

export const TIMINGS = {
  hero: { keys: [0, 0, 0, 0], release: [125, 534], travel: [534, 946], unroll: [946, 1250], caret: false, total: 1250 },
  loader: { keys: [0, 0, 0, 0], release: [95, 406], travel: [406, 719], unroll: [719, 950], caret: false, total: 1200 },
} as const satisfies Record<string, Timing>;

export type TimingName = keyof typeof TIMINGS;
export type Phase = "typing" | "beat" | "release" | "travel" | "unroll" | "ready" | "rest";

export interface LogoFrame {
  phase: Phase;
  letters: readonly { visible: boolean; d: string }[];
  piece: { visible: boolean; moved: boolean; points: readonly Point[]; ink?: number };
  q?: { weight: number; ink: number };
  caret: { visible: boolean; x: number };
}

export const CARET = { width: 4, top: TOP, height: BOTTOM - TOP, gap: 14 } as const;
const CARET_READY_X = TAIL_X + Q_STROKE / 2 + 12;
const CARET_START_X = -10;
const PEEL_END = .30;
const PEEL_RUN = 58;
const PEEL_Y = 114;
const PEEL_CENTER = LETTER_X[0] + BODY / 2;
const TRACK_START = PEEL_CENTER + PEEL_RUN - PIECE_LENGTH / 2;
const FIRST_FLAT = TRACK_START + PIECE_LENGTH;
const TURN_RADIUS = 14;
const TRACK_Y = HEIGHT + TURN_RADIUS;
const TURN_X = LAST_O_RIGHT - TURN_RADIUS;
const CURVE_END_X = 325;
const SAMPLES = 56;
const STEP = PIECE_LENGTH / SAMPLES;

// Sample the shallow approach once so frames can follow the track by distance.
const CURVE_STEPS = 48;
const curve = Array.from({ length: CURVE_STEPS + 1 }, (_, i) => {
  const t = i / CURVE_STEPS;
  const s = 1 - t;
  return [
    s ** 3 * FIRST_FLAT + 3 * s * s * t * 210 + 3 * s * t * t * 244 + t ** 3 * CURVE_END_X,
    mix(PEEL_Y, TRACK_Y, smooth(t)),
  ] as const;
});
const curveLengths = [0];
for (let i = 1; i < curve.length; i++) {
  const [x, y] = curve[i]!;
  const [px, py] = curve[i - 1]!;
  curveLengths.push(curveLengths[i - 1]! + Math.hypot(x - px, y - py));
}

const CURVE_END = PIECE_LENGTH + curveLengths.at(-1)!;
const TURN_START = CURVE_END + TURN_X - CURVE_END_X;
const TURN_END = TURN_START + Math.PI * TURN_RADIUS / 2;
const TRACK_LENGTH = TURN_END + PIECE_LENGTH;

function trackPoint(distance: number): Point {
  if (distance <= PIECE_LENGTH) return [TRACK_START + distance, PEEL_Y];
  if (distance < CURVE_END) {
    const offset = distance - PIECE_LENGTH;
    const next = curveLengths.findIndex((end) => end >= offset);
    const t = (offset - curveLengths[next - 1]!) / (curveLengths[next]! - curveLengths[next - 1]!);
    const [a, b] = [curve[next - 1]!, curve[next]!];
    return [mix(a[0], b[0], t), mix(a[1], b[1], t)];
  }
  if (distance < TURN_START) return [CURVE_END_X + distance - CURVE_END, TRACK_Y];
  if (distance < TURN_END) {
    const angle = (distance - TURN_START) / TURN_RADIUS;
    return [TURN_X + TURN_RADIUS * Math.sin(angle), HEIGHT + TURN_RADIUS * Math.cos(angle)];
  }
  return [LAST_O_RIGHT, HEIGHT - (distance - TURN_END)];
}

const baseAngles = Array.from({ length: SAMPLES }, (_, i) => {
  const distance = (i + .5) * STEP;
  return Math.PI / 2 * (1 - clamp(distance / CORNER) - clamp((distance - CORNER - FLAT) / CORNER));
});

function peel(progress: number): Point[] {
  const t = progress / PEEL_END;
  const straighten = smooth(t);
  const centerX = PEEL_CENTER + PEEL_RUN * t * t;
  const centerY = mix(BOTTOM - RADIUS, PEEL_Y, straighten);
  const points: Point[] = [[0, 0]];
  let x = 0;
  let y = 0;
  for (const angle of baseAngles) {
    const tangent = angle * (1 - straighten);
    x += Math.cos(tangent) * STEP;
    y += Math.sin(tangent) * STEP;
    points.push([x, y]);
  }
  return points.map(([px, py]) => [centerX + px - x / 2, centerY + py - y / 2]);
}

function slideDistance(progress: number): number {
  const t = (progress - PEEL_END) / (1 - PEEL_END);
  // Match the speed at the end of the peel, then accelerate along the track.
  const initialSpeed = 2 * PEEL_RUN / PEEL_END * (1 - PEEL_END);
  return PIECE_LENGTH + initialSpeed * t + (TRACK_LENGTH - PIECE_LENGTH - initialSpeed) * t * t;
}

function slide(distance: number, shift: number): Point[] {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const [x, y] = trackPoint(distance - PIECE_LENGTH + i * STEP);
    return [x - shift, y];
  });
}

function motionProgress(ms: number, timing: Timing): number {
  // Map custom stage lengths onto the reference clock before easing the motion.
  const hero = TIMINGS.hero;
  const span = hero.unroll[1] - hero.release[0];
  const travel = (hero.travel[0] - hero.release[0]) / span;
  const turn = (hero.unroll[0] - hero.release[0]) / span;
  if (ms < timing.travel[0]) {
    return smooth(travel * fraction(ms, ...timing.release));
  }
  if (ms < timing.unroll[0]) {
    return smooth(mix(travel, turn, fraction(ms, ...timing.travel)));
  }
  return smooth(mix(turn, 1, fraction(ms, ...timing.unroll)));
}

export const TAIL: readonly Point[] = [[TAIL_X, HEIGHT], [TAIL_X, TAIL_TOP]];

/** The logo at `ms` into the animation. Past the end, or at Infinity, it is at rest. */
export function logoFrame(ms: number, timing: Timing = TIMINGS.hero): LogoFrame {
  const { keys } = timing;
  const shown = keys.map((key) => ms >= key);
  const progress = motionProgress(ms, timing);
  const distance = progress < PEEL_END ? PIECE_LENGTH : slideDistance(progress);
  const dock = ramp(distance, TRACK_LENGTH - 39, TRACK_LENGTH);
  const stem = mix(BOTTOM - RADIUS, BOTTOM, ramp(progress, 0, .27));
  const lastShown = shown.lastIndexOf(true);

  let caretVisible = ms < timing.release[0] && !(ms > keys[3] + 180 && ms < Math.min(timing.release[0], keys[3] + 330));
  let caretX = lastShown < 0 ? CARET_START_X : LETTER_X[lastShown]! + BODY + CARET.gap;
  if (timing.ready && ms >= timing.ready[0] && ms < timing.ready[1]) {
    const q = (ms - timing.ready[0]) / (timing.ready[1] - timing.ready[0]);
    caretVisible = q < .45 || q > .7;
    caretX = CARET_READY_X;
  }

  const phase: Phase =
    ms <= keys[3] ? "typing"
    : ms < timing.release[0] ? "beat"
    : ms < timing.travel[0] ? "release"
    : ms < timing.unroll[0] ? "travel"
    : ms < timing.unroll[1] ? "unroll"
    : timing.ready && ms < timing.ready[1] ? "ready"
    : "rest";

  return {
    phase,
    letters: [
      { visible: shown[0]!, d: archPath(stem) },
      { visible: shown[1]!, d: oPath(LETTER_X[1]) },
      { visible: shown[2]!, d: oPath(LETTER_X[2]) },
      { visible: shown[3]!, d: qPath(dock) },
    ],
    piece: {
      visible: shown[0]!,
      moved: ms >= timing.release[0],
      ink: ramp(progress, 0, .14),
      points: progress === 1 ? TAIL : progress < PEEL_END ? peel(progress) : slide(distance, DOCK_SHIFT * dock),
    },
    q: { weight: mix(STROKE, Q_STROKE, dock), ink: ramp(distance, TRACK_LENGTH - 39, TRACK_LENGTH - 2) },
    caret: { visible: timing.caret !== false && caretVisible, x: caretX },
  };
}

export const REST: LogoFrame = logoFrame(Infinity);
export const pointsAttr = (points: readonly Point[]): string => points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}
