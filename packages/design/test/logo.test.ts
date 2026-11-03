import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { logoAssets } from "../src/brand/assets.ts";
import {
  BASELINE,
  BODY,
  BOTTOM,
  fmt,
  LETTER_X,
  logoFrame,
  PIECE_LENGTH,
  polylineLength,
  Q_STROKE,
  RADIUS,
  REST,
  STROKE,
  TAIL_TOP,
  TAIL_X,
  TIMINGS,
  TOP,
  WIDTH,
  type Timing,
} from "../src/brand/geometry.ts";
import { animateWordmark, mark, renderWordmarkFrame, wordmark } from "../src/brand/wordmark.ts";
import type { Tokens } from "../src/tokens.ts";

const tokens = (await Bun.file(new URL("../tokens.json", import.meta.url)).json()) as Tokens;
const timings = Object.entries(TIMINGS) as [string, Timing][];
/** Inside the counter of the letter at centerline x = lx: the centerline inset by half a stroke, corners rounded. */
function inCounter(lx: number, x: number, y: number): boolean {
  const [x0, x1, y0, y1, r] = [lx + STROKE / 2, lx + BODY - STROKE / 2, TOP + STROKE / 2, BOTTOM - STROKE / 2, RADIUS - STROKE / 2];
  if (x <= x0 || x >= x1 || y <= y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) < r;
}

/** Every 10ms through a timing, plus the exact phase boundaries. */
const frames = (t: Timing) => {
  const ms = new Set<number>();
  for (let m = 0; m <= t.total; m += 10) ms.add(m);
  for (const edge of [...t.keys, ...t.release, ...t.travel, ...t.unroll, ...(t.ready ?? [])]) ms.add(edge);
  return [...ms].sort((a, b) => a - b);
};

describe("the starting letters", () => {
  test("the starting letters share one centerline module", () => {
    const steps = LETTER_X.slice(1).map((x, i) => x - LETTER_X[i]!);
    expect(new Set(steps).size).toBe(1);
    expect(BOTTOM - TOP).toBe(100 - STROKE);
    expect(WIDTH).toBe(LETTER_X[3]! + BODY + STROKE / 2);
  });

  test("the piece is an o's base: its ends meet the sides where the corners begin", () => {
    const points = logoFrame(0).piece.points;
    for (const [point, x] of [[points[0]!, LETTER_X[0]], [points.at(-1)!, LETTER_X[0] + BODY]] as const) {
      expect(point[0]).toBeCloseTo(x, 1);
      expect(point[1]).toBeCloseTo(BOTTOM - RADIUS, 8);
    }
  });
});

describe("the Move conserves the piece", () => {
  for (const [name, t] of timings) {
    test(`${name}: the piece is ${PIECE_LENGTH.toFixed(2)} long in every frame`, () => {
      for (const ms of frames(t)) expect(polylineLength(logoFrame(ms, t).piece.points)).toBeCloseTo(PIECE_LENGTH, 1);
    });
  }

  test("at rest, the q's tail is exactly the piece, hanging straight from the bowl's corner", () => {
    const pts = REST.piece.points;
    expect(pts.at(-1)).toEqual([TAIL_X, TAIL_TOP]);
    expect(pts.at(-1)![0]).toBeCloseTo(TAIL_X, 9);
    expect(pts[0]![1]).toBeCloseTo(TAIL_TOP + PIECE_LENGTH, 9);
    for (const [x] of pts) expect(x).toBeCloseTo(TAIL_X, 9);
  });

  test("at rest, the n stems end at the o's lower centerline", () => {
    expect(REST.letters[0]!.d).toStartWith(`M${LETTER_X[0]} ${BOTTOM}V`);
    expect(REST.letters[0]!.d).toEndWith(`V${BOTTOM}`);
  });
});

describe("the choreography", () => {
  for (const [name, t] of timings) {
    test(`${name}: opens on all four o's with no caret`, () => {
      const f = logoFrame(0, t);
      expect(f.letters.every((l) => l.visible)).toBe(true);
      expect(f.piece.visible).toBe(true);
      expect(f.piece.moved).toBe(false);
      expect(f.caret.visible).toBe(false);
      expect(f.q).toEqual({ weight: STROKE, ink: 0 });
    });

    test(`${name}: moves through the phases in order and ends at rest`, () => {
      const order = ["typing", "beat", "release", "travel", "unroll", "ready", "rest"];
      const seen = frames(t).map((ms) => logoFrame(ms, t).phase);
      const indices = seen.map((p) => order.indexOf(p));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(seen.at(-1)).toBe("rest");
      expect(logoFrame(t.total, t)).toEqual({ ...REST, caret: { ...REST.caret, x: logoFrame(t.total, t).caret.x } });
    });

    test(`${name}: the piece turns to ink when it lets go, and stays ink`, () => {
      expect(logoFrame(t.release[0] - 1, t).piece.moved).toBe(false);
      for (const ms of frames(t).filter((m) => m >= t.release[0])) expect(logoFrame(ms, t).piece.moved).toBe(true);
    });

    test(`${name}: frames join without jumps between phases`, () => {
      for (const edge of [t.release[1], t.travel[0], t.travel[1], t.unroll[0]]) {
        const [a, b] = [logoFrame(edge - 0.01, t).piece.points, logoFrame(edge + 0.01, t).piece.points];
        expect(Math.hypot(a[0]![0] - b[0]![0], a[0]![1] - b[0]![1])).toBeLessThan(0.5);
        expect(Math.hypot(a.at(-1)![0] - b.at(-1)![0], a.at(-1)![1] - b.at(-1)![1])).toBeLessThan(0.5);
      }
    });

    test(`${name}: in flight, the piece never cuts through the n or the two o's`, () => {
      const travel = frames(t).filter((ms) => ms > t.travel[0] && ms < t.travel[1]);
      const inflate = STROKE / 2;
      for (const ms of travel) {
        for (const [x, y] of logoFrame(ms, t).piece.points) {
          for (const i of [0, 1, 2]) {
            const inside = x > LETTER_X[i]! - inflate && x < LETTER_X[i]! + BODY + inflate && y < BASELINE + inflate;
            expect(inside).toBe(false);
          }
        }
      }
    });

    test(`${name}: the piece's centerline never enters a counter`, () => {
      for (const ms of frames(t)) {
        if (ms < t.release[1]) continue;
        for (const [x, y] of logoFrame(ms, t).piece.points) {
          for (const lx of LETTER_X) expect(inCounter(lx, x, y)).toBe(false);
        }
      }
    });
  }

  test("the ink follows the upright stroke around the bowl", () => {
    const t = TIMINGS.hero;
    const f = frames(t).map((ms) => logoFrame(ms, t)).find((frame) => frame.q!.ink > 0 && frame.q!.ink < 1)!;
    const [tip, behind] = f.piece.points.slice(-2).reverse();
    expect(tip![0]).toBeCloseTo(behind![0], 8);
    expect(tip![1]).toBeLessThan(behind![1]!);
    expect(f.letters[3]!.d).toStartWith(`M${fmt(tip![0])} `);
    expect(REST.q).toEqual({ weight: Q_STROKE, ink: 1 });
  });

  test("custom timings can still type the letters and park the caret", () => {
    const t: Timing = {
      keys: [0, 150, 270, 410],
      release: [800, 950], travel: [950, 1300], unroll: [1300, 1750],
      ready: [1800, 2100], total: 2100,
    };
    expect(logoFrame(-1, t).letters.every((l) => !l.visible)).toBe(true);
    t.keys.forEach((key, i) => {
      expect(logoFrame(key - 1, t).letters[i]!.visible).toBe(false);
      expect(logoFrame(key, t).letters[i]!.visible).toBe(true);
    });
    expect(logoFrame(t.keys[3] + 250, t).caret.visible).toBe(false);
    expect(logoFrame(1840, t).caret.visible).toBe(true);
    expect(logoFrame(1840, t).caret.x).toBeGreaterThan(TAIL_X + Q_STROKE / 2);
    expect(logoFrame(1980, t).caret.visible).toBe(false);
  });
});

describe("wordmark()", () => {
  test("is a labeled image at rest", () => {
    const el = wordmark();
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("nooq");
    expect(el.querySelector("title")?.textContent).toBe("nooq");
    expect(el.dataset.phase).toBe("rest");
    expect(el.querySelectorAll(".nq-logo-letter").length).toBe(4);
    expect(el.querySelector(".nq-logo-piece")?.classList.contains("is-moved")).toBe(true);
    expect(el.querySelector(".nq-logo-caret")?.getAttribute("opacity")).toBe("0");
  });

  test("mono uses one ink from CSS color", () => {
    expect(wordmark({ mono: true }).classList.contains("nq-logo-mono")).toBe(true);
  });

  test("renderWordmarkFrame draws any frame", () => {
    const el = wordmark();
    const f = logoFrame(1100, TIMINGS.hero);
    renderWordmarkFrame(el, f);
    const op = Array.from(el.querySelectorAll(".nq-logo-letter")).map((l) => l.getAttribute("opacity"));
    expect(op).toEqual(["1", "1", "1", "1"]);
    expect(el.querySelector(".nq-logo-piece")?.classList.contains("is-moved")).toBe(true);
    expect(el.querySelector(".nq-logo-ink")?.getAttribute("visibility")).toBe("visible");
    expect(el.dataset.phase).toBe("unroll");
  });

  test("with reduced motion, nothing moves: it resolves at rest immediately", async () => {
    const el = wordmark();
    renderWordmarkFrame(el, logoFrame(0));
    const anim = animateWordmark(el, { reducedMotion: true });
    await anim.finished;
    expect(el.dataset.phase).toBe("rest");
  });

  test("cancel always leaves the logo whole", async () => {
    const el = wordmark();
    const anim = animateWordmark(el, { timing: "loader", reducedMotion: false });
    expect(el.dataset.phase).toBe("typing");
    anim.cancel();
    await anim.finished;
    expect(el.dataset.phase).toBe("rest");
    expect(el.querySelector(".nq-logo-piece")?.getAttribute("points")).toBe(wordmark().querySelector(".nq-logo-piece")?.getAttribute("points"));
  });

  test("a replay replaces the in-flight animation", async () => {
    const el = wordmark();
    const first = animateWordmark(el, { reducedMotion: false });
    const replay = animateWordmark(el, { reducedMotion: false });
    await first.finished;
    first.cancel();
    expect(el.dataset.phase).toBe("typing");
    replay.cancel();
    await replay.finished;
    expect(el.dataset.phase).toBe("rest");
  });

  test("mark() is the same inked q that ends the wordmark", () => {
    const m = mark();
    expect(m.querySelectorAll(".nq-logo-letter").length).toBe(1);
    expect(m.getAttribute("aria-label")).toBe("nooq");
    const bowl = m.querySelector(".nq-logo-letter")!;
    const wordmarkBowl = wordmark().querySelectorAll(".nq-logo-letter")[3]!;
    expect(bowl.getAttribute("d")).toBe(wordmarkBowl.getAttribute("d"));
    expect(bowl.getAttribute("stroke-width")).toBe(String(Q_STROKE));
    expect(bowl.classList.contains("is-ink")).toBe(true);
    expect(wordmarkBowl.classList.contains("is-ink")).toBe(true);
  });
});

describe("assets/", () => {
  const assets = logoAssets(tokens);

  for (const [name, svg] of Object.entries(assets)) {
    test(`${name} is up to date (run \`bun run logo\`)`, async () => {
      expect(await Bun.file(new URL(`../assets/${name}`, import.meta.url)).text()).toBe(svg);
    });
  }

  test("colors come from tokens: graphite noo, ink q, per theme", () => {
    expect(assets["nooq-wordmark.svg"]).toContain('stroke="#15171c"');
    expect(assets["nooq-wordmark.svg"]).toContain('stroke="#2343d1"');
    expect(assets["nooq-wordmark-dark.svg"]).toContain('stroke="#eceef2"');
    expect(assets["nooq-wordmark-dark.svg"]).toContain('stroke="#93a6ff"');
    expect(assets["nooq-wordmark-mono.svg"]).not.toContain("#2343d1");
    expect(assets["nooq-mark.svg"]!.match(/stroke="#2343d1"/g)).toHaveLength(2);
  });

  test("every file is a labeled image", () => {
    for (const svg of Object.values(assets)) {
      expect(svg).toContain('role="img"');
      expect(svg).toContain("<title>nooq</title>");
    }
  });
});
