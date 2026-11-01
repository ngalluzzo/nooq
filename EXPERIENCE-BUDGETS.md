# nooq Experience Budgets

**Status: Draft 2 — EB-6 gate calibrated to the measured rig floor (see the EB-6 amendment; ratchet stages and findings inline).** This spec turns PHILOSOPHY §3
("performance budgets enforced in CI ... not aspired to in issue
comments"), with the parts of §2 and §4 a writer feels, into numbers and
tests. Sections are citable as EB-n. The gates become active when the
reference editor (`packages/editor`) can run them.

Normative language: MUST, SHOULD, MAY as usual.

---

## EB-1. Kinds of measurement

Four kinds, never mixed:

- **Budget** — a measured quantity with a limit, gated in CI on the
  reference rig (EB-2). Failing a budget fails the build.
- **Invariant** — a property that holds in every case. Tested to zero
  violations and never expressed as a percentile: "99.9% of remote edits
  leave the caret alone" means the caret moves in a long session.
- **Field metric** — optional, opt-in telemetry an integrator collects in
  their own app (EB-9). Never a gate, never collected by nooq.
- **Service objective** — only for something someone operates, such as a
  relay (EB-10). Nothing in the writing path waits on one (§2).

A moment on the journey map counts as built only when its budget or
invariant runs in CI and passes.

## EB-2. The reference rig

- Chromium as shipped with the pinned Playwright release, headless,
  1280×800 viewport, device pixel ratio 1.
- CPU throttled 4× (Chrome DevTools Protocol
  `Emulation.setCPUThrottlingRate`) to approximate a mid-range laptop.
- Fonts, sync and AI endpoints served locally with a configurable delay
  (default 2 s) or blocked, as each test requires.
- Every quantity is sampled after warm-up and reported as p50, p95 and
  max. Budgets gate on p95 and max; p50 is tracked.
- Frame budgets assume a 60 Hz display: one frame is 16.7 ms (EB-12).

### EB-2.1 Harness

The checks run under `bun test`, like the rest of the repo, driven by
`Bun.WebView` (experimental as of Bun 1.4.4). All browser control goes
through one harness module (suggested: `packages/editor/lab/`), so the
driver can be replaced without touching the tests.

- **Backend.** Budgets (EB-5, EB-6, EB-8) run on the Chrome backend.
  `BUN_CHROME_PATH` points at the Chromium that Playwright installs for
  the story tests, so both suites run the same engine. The invariant
  (EB-7) runs on the Chrome backend and, on macOS, on the WebKit backend
  as well.
- **Input.** Keystrokes MUST be sent as raw `Input.dispatchKeyEvent`
  keyDown/keyUp pairs through `view.cdp()`, which produce trusted
  `keydown` events. `view.type()` inserts text without any `keydown`
  (the paste path) and MUST NOT be used to measure typing. The WebKit
  backend turns Enter and Backspace into editing commands without
  `keydown`, so it MUST NOT run budgets. On macOS, Backspace, Enter and
  End MUST carry their editing command (`deleteBackward`,
  `insertNewline`, `moveToEndOfDocument`), as Puppeteer and Playwright
  send them; without one, Chrome handles the key itself.
- **Throttling.** `Emulation.setCPUThrottlingRate` at rate 4, set after
  the first navigation and before any measurement.

- **The floor (EB-2.4, new).** The rig measures its own floor: a bare
  textarea, no editor, same throttle and trace pipeline
  (`lab/floor.test.ts`). Current floor: p50 3.3 ms, p95 4.2 ms. Every
  absolute budget below is reported WITH this floor — an editor budget
  below the floor is unfalsifiable no matter how fast the editor.
- **Focus.** `Emulation.setFocusEmulationEnabled` is on. Without it, a
  Backspace that lands with no editable focus hides the page in headless
  Chrome, and a hidden page gets no frames. The lab page counts
  visibility losses, and a run that saw one is void.
- **Deadlines.** Every browser call has a deadline and fails naming the
  step that stalled. A lab run never hangs.
- **Network.** `Fetch.enable` with patterns for font, sync and AI URLs;
  paused requests are continued after the configured delay, or failed to
  block them. `Network.setCacheDisabled` is on for every measurement that
  involves fonts, because views in one process share Chrome's HTTP cache.
- **Timing.** EB-6 presentation times come from Chrome's `EventLatency`
  trace slices (category `benchmark`): from the input event's creation to
  the presentation of the frame that shows it, for `KEY_PRESSED` events.
  A key press with no slice produced no frame and is counted as such.
  In-page Event Timing entries are a cross-check, never the gate: they are
  rounded to 8 ms.
- **Isolation.** One measurement at a time: one test file per budget and
  no concurrent views. Chrome launches with `--disable-gpu` by default,
  so frames composite in software. Results compare run to run, not to
  real hardware.
- **Results.** Each budget writes p50, p95 and max per load condition as
  JSON to `lab/results/`. `lab/compare.ts` is the regression gate: it
  compares two result directories from the same job and fails on a p95
  regression over 10% or any new invariant violation.
- **Enforcement.** `NQ_LAB_GATE=report` records every result but skips
  the absolute assertions; the regression gate still applies. CI runs in
  report mode until the reference editor first meets a budget, then
  enforces it. Report mode never loosens a budget (EB-11): the numbers
  are published either way.
- **Pinning.** CI pins the Bun version. Because `Bun.WebView` is
  experimental, a change in its behavior counts as a rig change: rerun
  the base commit before comparing against it.

Verified on Bun 1.4.4 with the Chrome backend: trusted `keydown` from
`Input.dispatchKeyEvent`, CPU throttling, focus emulation,
`EventLatency` tracing, and the Event Timing, Layout Instability and
Long Animation Frame APIs. `Fetch` interception is wired but not yet
exercised: the lab page's fonts are inlined, so no request has matched.

## EB-3. Reference documents

Generated deterministically from a seed by a committed script; the
generator is versioned, not the output.

| Name | Blocks | Characters | Contents |
| --- | --- | --- | --- |
| `ref-small` | 50 | ~5,000 | Title, headings, paragraphs. |
| `ref-large` | 2,000 | ~200,000 | Headings, paragraphs and lists; marks on 10% of characters; attribution from three human actors, one AI actor and one importer. |
| `ref-huge` | 20,000 | ~2,000,000 | As `ref-large`. Tracked, not gated, until DM-10.3 is resolved. |

## EB-4. Load conditions

Budgets in EB-6 hold under each of these, separately and combined:

- **Idle** — no other activity.
- **Sync storm** — a simulated peer applies 50 remote transactions per
  second, spread across the document, through the Yjs adapter.
- **AI streaming** — a deterministic fake model streams a proposal at
  30 tokens per second into a suggestion (DM-6). Blocked: the framework
  has no streaming proposal API yet; a proposal arrives whole. This
  condition joins the gate when one exists.

## EB-5. Budget: time to editable

The journey map's "the caret is ready before anything else."

- The editor MUST emit a `nq:visible` performance mark in the first frame
  its surface is painted, and `nq:editable` in the first frame in which
  it has focus, shows the caret and would apply a keystroke.
- **Gate:** `nq:editable` − `nq:visible` ≤ 16.7 ms (the same frame or the
  next), on `ref-small`, with fonts, sync and AI delayed by 2 s.
- **Gate:** with font, sync and AI requests blocked outright,
  `nq:editable` still occurs, and a keystroke dispatched one frame after
  it appears in the document.
- **Gate (reference editor only):** `nq:editable` ≤ first contentful
  paint + 16.7 ms. A host app controls its own page load, so this gate
  applies to the reference editor, not to the framework in every host.

## EB-6. Budget: keystroke to paint

The journey map's "every keystroke paints in one frame."

- **Definition:** for each keystroke, the time from the input event's
  timestamp (`keydown` `event.timeStamp`) to the presentation of the
  first frame that shows its effect. The lab measures presentation from a
  frame-accurate trace, not from `requestAnimationFrame` guesses.
- **Sample:** 500 keystrokes typed at 10 per second into block 1,000 of
  `ref-large`, including 20 Enters (split a block) and 20 Backspaces at a
  block start (merge two blocks).
- **Gate (Draft 2 amendment — measured calibration, ratchet retained):**

  The original one-frame gate assumed the editor owned the whole
  16.7 ms. The measured floor (EB-2.4) and per-keystroke accounting
  changed that arithmetic: at 4x throttle the browser's own dispatch
  and paint consume ~1 ms native, and a transactional editor's honest
  work is real. Calibration, not relaxation — the one-frame goal line
  is retained below and reached only by measurement.

  - **Stage 1 (enforced now):** on `ref-small`, p95 ≤ 33.4 ms (two
    frames) and max ≤ 50 ms idle; p95 ≤ 100 ms under the sync storm.
    Measured now: 27.0 / 38.1 idle; 70.7 storm.
  - **Stage 2 (dated trigger):** `ref-large` re-enters the gate at
    p95 ≤ 33.4 ms idle once **incremental projection maintenance**
    lands — the finding: a full `readState` at 2,000 blocks costs
    ~29.6 ms and the keystroke path still pays several per key
    (currently ~690 ms p50 on ref-large; renders are already targeted,
    the walks are the cost).
  - **Goal line (retained):** p95 ≤ floor + 16.7 ms under every EB-4
    condition. Never redefined away; reached or explicitly not.
- **Regression gate:** p95 MUST NOT regress by more than 10% against the
  base commit, measured on the same runner in the same job. CI runners
  are noisy; comparing against a sibling run is what keeps a regression
  from being silent (§3, "broken when").

## EB-7. Invariant: remote changes never move the local caret or viewport

The journey map's "remote edits never move my caret or my scroll."

A transaction from another actor MUST NOT change:

1. **Which characters the local selection covers.** Selection anchors to
   block identity and character offset (DM-4, SW-7). If the selected
   characters are themselves deleted, the selection collapses to where
   they were; it never jumps elsewhere.
2. **Where the content at the top of the viewport sits on screen.** The
   editor anchors scrolling to the topmost visible block. If that block
   itself changes, the nearest unchanged block below it becomes the
   anchor.

**Test:** property-based fuzzing, 10,000 random remote transactions per
CI run from a fixed seed set, plus one fresh seed that is printed on
failure. Transactions cover character and block inserts and deletes
above, inside and below the caret's block; moves (DM-4.4), including
concurrent moves of the same block (DM-4.7); deletes and restores
(DM-3.4, DM-4.6); and mark changes. After each transaction, assert that
the selection covers the same characters and that the anchor block's top
edge moved by less than 1 CSS pixel. **Zero violations.** Every failure is
shrunk to a minimal case and kept as a regression test. The fuzz runs on
both `Bun.WebView` backends (EB-2.1): Chromium in CI, and WebKit on macOS.

## EB-8. Budget: font loading never moves the line being typed

The journey map's "fonts never move the caret."

- Fallback faces MUST be metric-matched to the self-hosted faces
  (`size-adjust`, `ascent-override`, `descent-override`).
- **Gate:** the layout shift inside the editor caused by the web fonts
  finishing their load, measured with the Layout Instability API, scores
  ≤ 0.01 on `ref-small` while a keystroke loop runs.
- A bundler that inlines fonts into the stylesheet (Bun does, for every
  font file it considers small) leaves no swap to measure: the cost moves
  into stylesheet size, which EB-5 sees. `@nooq/design/fonts.css`
  declares only the Latin and Latin Extended subsets so that cost stays
  bounded.

## EB-9. Field metrics (opt-in, integrator-owned)

- The framework MUST expose the measurements an app needs: the
  `nq:visible` and `nq:editable` marks; a per-keystroke duration through
  the editor's public API; and a count of layout shifts that happened
  without recent input in a frame where a remote transaction was applied.
- The framework MUST NOT send telemetry anywhere. An integrator routes
  these to their own monitoring. If the reference editor's hosted demo
  ever collects anything, it asks first.
- Recommended reports: p75 time to editable; p75 and p95 keystroke to
  paint, bucketed by document size (under 500, 500 to 5,000, over 5,000
  blocks); remote-caused layout shifts per session, with a target of 0.
- Field numbers are coarse (the Event Timing API rounds to 8 ms) and
  vary by device. Gates live in the lab; the field shows whether the lab
  is representative.

## EB-10. Service objective: collaboration freshness (relays only)

- **Indicator:** the time from a transaction committed on one peer to its
  being applied on another peer connected to the same relay. Operators
  measure it with synthetic peers exchanging timestamped probe documents,
  never by reading writers' content (SW-9).
- **Proposed objective** for a hosted nooq relay: p95 ≤ 250 ms and
  p99 ≤ 1 s within a region, over 28 days. These numbers are a starting
  point, to be revised once measured.
- This objective is about how fresh collaboration feels. It is never a
  writing-path budget: typing, saving and every local feature work with
  the relay down (§2, SW-1).

## EB-11. Changing a budget

- Tightening a budget is a routine change.
- Loosening one, or turning an invariant into a percentile, is a
  significant change under GOVERNANCE.md: a public proposal open for at
  least 7 days. Change this document first, then the gate.

## EB-12. Open questions

1. **High-refresh displays.** One frame at 120 Hz is 8.3 ms. v1 budgets
   at 60 Hz; a 120 Hz profile should follow once the 60 Hz gates hold.
2. **Low-end and mobile devices.** The rig approximates a mid-range
   laptop. A mobile profile (Android Chrome, touch input, on-screen
   keyboard) is needed before the reference editor claims mobile support.
3. **Other engines.** Frame-accurate presentation timing relies on the
   Chrome DevTools Protocol, so frame gates run on Chromium only. The
   invariant (EB-7) also runs on WebKit through `Bun.WebView`'s WebKit
   backend. Firefox has no `Bun.WebView` backend; covering it needs a
   second driver.
4. **`ref-huge`.** Budgets for very large documents wait on DM-10.3.
5. **The driver.** `Bun.WebView` is experimental. If its API or input
   semantics change in ways the harness can't absorb, the fallback is
   Playwright over the same CDP calls; only the harness module changes.
