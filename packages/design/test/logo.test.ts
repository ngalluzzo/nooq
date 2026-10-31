import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { logoAssets } from "../src/brand/assets.ts";
import {
  BASELINE,
  BODY,
  BOTTOM,
  LETTER_X,
  logoFrame,
  PIECE_LENGTH,
  piecePoint,
  polylineLength,
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

describe("the shared counter", () => {
  test("every letter is drawn on the same centerline module", () => {
    const steps = LETTER_X.slice(1).map((x, i) => x - LETTER_X[i]!);
    expect(new Set(steps).size).toBe(1);
    expect(BOTTOM - TOP).toBe(100 - STROKE);
    expect(WIDTH).toBe(LETTER_X[3]! + BODY + STROKE / 2);
  });

  test("the piece is an o's base: its ends meet the sides where the corners begin", () => {
    expect(piecePoint(0, 0)).toEqual([0, BOTTOM - RADIUS]);
    const [x, y] = piecePoint(0, PIECE_LENGTH - 1e-9);
    expect(x).toBeCloseTo(BODY, 6);
    expect(y).toBeCloseTo(BOTTOM - RADIUS, 6);
  });
});

describe("the Move conserves the piece", () => {
  for (const [name, t] of timings) {
    test(`${name}: the piece is ${PIECE_LENGTH.toFixed(2)} long in every frame`, () => {
      for (const ms of frames(t)) expect(polylineLength(logoFrame(ms, t).piece.points)).toBeCloseTo(PIECE_LENGTH, 0);
    });
  }

  test("at rest, the q's tail is exactly the piece, hanging straight from the bowl's corner", () => {
    const pts = REST.piece.points;
    expect(pts[0]).toEqual([TAIL_X, TAIL_TOP]);
    expect(pts.at(-1)![0]).toBeCloseTo(TAIL_X, 9);
    expect(pts.at(-1)![1]).toBeCloseTo(TAIL_TOP + PIECE_LENGTH, 9);
    for (const [x] of pts) expect(x).toBeCloseTo(TAIL_X, 9);
  });

  test("at rest, the first letter is an n: its stems reach the baseline", () => {
    expect(REST.letters[0]!.d).toStartWith(`M${LETTER_X[0]} ${BASELINE}V`);
    expect(REST.letters[0]!.d).toEndWith(`V${BASELINE}`);
  });
});

describe("the choreography", () => {
  for (const [name, t] of timings) {
    test(`${name}: starts empty except for the caret`, () => {
      const f = logoFrame(-1, t);
      expect(f.letters.every((l) => !l.visible)).toBe(true);
      expect(f.piece.visible).toBe(false);
      expect(f.caret.visible).toBe(true);
    });

    test(`${name}: types the four o's in order, each at its key`, () => {
      t.keys.forEach((k, i) => {
        expect(logoFrame(k - 1, t).letters[i]!.visible).toBe(false);
        expect(logoFrame(k, t).letters[i]!.visible).toBe(true);
      });
      // Before the release, all four are identical o's: the arch plus its attached base.
      const f = logoFrame(t.release[0] - 1, t);
      expect(f.piece.moved).toBe(false);
      expect(f.piece.points[0]).toEqual([LETTER_X[0]!, BOTTOM - RADIUS]);
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

  test("the hero parks the caret after the q and blinks; the loader does not", () => {
    const hero = TIMINGS.hero;
    const at = (q: number) => logoFrame(hero.ready[0] + q * (hero.ready[1] - hero.ready[0]), hero);
    expect(at(0.2).caret).toEqual({ visible: true, x: at(0.2).caret.x });
    expect(at(0.2).caret.x).toBeGreaterThan(TAIL_X + STROKE / 2);
    expect(at(0.6).caret.visible).toBe(false);
    expect(at(0.85).caret.visible).toBe(true);
    expect(logoFrame(TIMINGS.loader.unroll[1] + 10, TIMINGS.loader).caret.visible).toBe(false);
  });

  test("the caret blinks once in the beat after oooo", () => {
    const t = TIMINGS.hero;
    expect(logoFrame(t.keys[3] + 100, t).caret.visible).toBe(true);
    expect(logoFrame(t.keys[3] + 250, t).caret.visible).toBe(false);
    expect(logoFrame(t.keys[3] + 400, t).caret.visible).toBe(true);
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
    const f = logoFrame(TIMINGS.hero.keys[1], TIMINGS.hero);
    renderWordmarkFrame(el, f);
    const op = Array.from(el.querySelectorAll(".nq-logo-letter")).map((l) => l.getAttribute("opacity"));
    expect(op).toEqual(["1", "1", "0", "0"]);
    expect(el.querySelector(".nq-logo-piece")?.classList.contains("is-moved")).toBe(false);
    expect(el.dataset.phase).toBe("typing");
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

  test("mark() is the q alone", () => {
    const m = mark();
    expect(m.querySelectorAll(".nq-logo-letter").length).toBe(1);
    expect(m.getAttribute("aria-label")).toBe("nooq");
  });
});

describe("assets/", () => {
  const assets = logoAssets(tokens);

  for (const [name, svg] of Object.entries(assets)) {
    test(`${name} is up to date (run \`bun run logo\`)`, async () => {
      expect(await Bun.file(new URL(`../assets/${name}`, import.meta.url)).text()).toBe(svg);
    });
  }

  test("colors come from tokens: graphite letters, ink tail, per theme", () => {
    expect(assets["nooq-wordmark.svg"]).toContain('stroke="#15171c"');
    expect(assets["nooq-wordmark.svg"]).toContain('stroke="#2343d1"');
    expect(assets["nooq-wordmark-dark.svg"]).toContain('stroke="#eceef2"');
    expect(assets["nooq-wordmark-dark.svg"]).toContain('stroke="#93a6ff"');
    expect(assets["nooq-wordmark-mono.svg"]).not.toContain("#2343d1");
  });

  test("every file is a labeled image", () => {
    for (const svg of Object.values(assets)) {
      expect(svg).toContain('role="img"');
      expect(svg).toContain("<title>nooq</title>");
    }
  });
});
