/**
 * The lab page: mounts the reference editor on a reference document and
 * reports what the harness needs. It only observes; it never helps the
 * editor (no focusing on its behalf, no marks it should emit itself).
 *
 * `?condition=sync-storm` connects the editor to an in-page relay with a
 * second peer that edits other blocks at a steady rate (EB-4).
 */

import * as Y from "yjs";
import { applyTransaction } from "@nooq/yjs";
import { newBlockId, type BlockId, type Op } from "@nooq/core";
import { NooqRelay } from "@nooq/sync";
import { Editor } from "../../src/controller.ts";
import { createSurface } from "../../src/dom.ts";
import { referencePlugins, referenceDOM, referenceJobBindings } from "../../src/reference.ts";

const params = new URLSearchParams(location.search);
const docName = params.get("doc") ?? "ref-small";
const condition = params.get("condition") ?? "idle";
const textMode = params.get("textMode") ?? "plain";
if (textMode !== "plain" && textMode !== "rich") throw new Error("Unsupported lab text mode");
const DOC_ID = `lab-${docName}`;

const relay = condition === "sync-storm" ? new NooqRelay() : null;
const editor = new Editor({
  plugins: referencePlugins, jobBindings: referenceJobBindings(),
  docId: DOC_ID,
  actor: { actorId: "human:lab", name: "Lab writer" },
  ...(relay ? { transport: relay.connect(DOC_ID) } : {}),
});
// EB-8: the projection attaches AFTER the bulk apply — seeding it from one
// readState outside the open Yjs transaction beats reseed-during-apply.
const update = new Uint8Array(await (await fetch(`/doc/${docName}?id=${DOC_ID}`)).arrayBuffer());
performance.mark("lab:fetched");
editor.applySeed(update); // EB-8: bulk apply with tracking suspended
performance.mark("lab:yjs-applied");
editor.attachMaintainedProjection();
performance.mark("lab:applied");
const peer = relay ? new Editor({ docId: DOC_ID, actor: { actorId: "human:storm", name: "Storm" }, transport: relay.connect(DOC_ID) }) : null;
const surface = createSurface(editor, { plugins: referenceDOM, textMode });
performance.mark("lab:surface");
document.getElementById("root")!.append(surface.element);

/**
 * Harness-observed marks, standing in until the editor emits nq:visible and
 * nq:editable itself (EB-5). "Visible": the first frame with block rows.
 * "Editable": the first frame where focus is inside the editor, with no help.
 */
let frames = 0;
const observedFrom = performance.now();
function observe(): void {
  frames++;
  const rows = surface.element.querySelectorAll("[data-nq-block]").length;
  if (rows > 0 && performance.getEntriesByName("lab:visible").length === 0) performance.mark("lab:visible");
  if (surface.element.contains(document.activeElement) && performance.getEntriesByName("lab:editable").length === 0) {
    performance.mark("lab:editable");
    return;
  }
  // Time-budgeted, not frame-budgeted: at 4x throttle a heavy mount exhausts
  // 240 frames before editable; 60s of frames keeps EB-5/8 measurable.
  if (performance.now() - observedFrom < 60_000) requestAnimationFrame(observe);
}
requestAnimationFrame(observe);

const remoteActor = { actorId: "human:remote", kind: "human" as const };
let remoteLamport = 0;

/** Times focus left the editor without the writer moving it (a re-render that dropped the caret, say). */
let focusLosses = 0;
document.addEventListener(
  "focusout",
  () => setTimeout(() => {
    if (!surface.element.contains(document.activeElement)) focusLosses++;
  }, 0),
  true,
);

/** A hidden page gets no frames; any measurement taken while hidden is void. */
let hiddenCount = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hiddenCount++;
});

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rowOf = (block: BlockId) => surface.element.querySelector<HTMLElement>(`[data-nq-block="${block}"]`);
const unmarked = (s: string) => ({ s, marks: Array.from({ length: s.length }, () => [] as string[]) });
/** The editor renders in microtasks; one macrotask later its DOM is current. */
const rendered = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Inspect native selection in either presentation; a missing range is not a passing probe. */
function textSelection(element: Element | null): [number, number] | null {
  if (element instanceof HTMLTextAreaElement) return [element.selectionStart, element.selectionEnd];
  const selection = document.getSelection();
  if (!(element instanceof HTMLElement) || !element.isContentEditable || !selection?.anchorNode || !selection.focusNode
    || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null;
  const offset = (node: Node, at: number) => { const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, at); return range.toString().length; };
  return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)];
}

let storm: ReturnType<typeof setInterval> | null = null;

/** Helpers the harness calls through view.evaluate(). */
const lab = {
  docName,
  condition,
  textMode,
  blockCount: () => surface.element.querySelectorAll("[data-nq-block]").length,
  /** Diagnostics: the direct engine path, bypassing the command runtime. */
  diagApply: (id: string) => { editor.applyTextChanges(id, [{ insert: "Z" }]); return lab.textOf(id)?.slice(0, 60) ?? null; },
  diagRun: (id: string) => { const r = editor.commands.run("nooq.text.edit", { block: id, changes: [{ insert: "W" }] }); return { status: r.status, text: lab.textOf(id)?.slice(0, 60) ?? null }; },
  /** EB-6/EB-8: scroll to a block by id, through windowing placeholders. */
  scrollToBlock: async (id: string): Promise<string> => {
    const direct = document.querySelector(`[data-nq-block="${CSS.escape(id)}"]`);
    if (direct && !direct.hasAttribute("data-nq-ph")) {
      direct.scrollIntoView({ block: "center" });
      const area = direct.querySelector("textarea, [contenteditable='true']") as HTMLElement | null;
      area?.focus({ preventScroll: true });
      return area && document.activeElement === area ? "landed" : "unfocused";
    }
    // Converge through the height cache: estimated tops approach reality as
    // rows are measured, so a couple of scroll-and-remeasure passes land it.
    for (let attempt = 0; attempt < 4; attempt++) {
      const top = (surface as { estimateTop(id: string): number }).estimateTop(id);
      if (top < 0) return "missing";
      window.scrollTo({ top: Math.max(0, top - window.innerHeight / 2) });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const real = document.querySelector(`[data-nq-block="${CSS.escape(id)}"]`);
      if (real && !real.hasAttribute("data-nq-ph")) {
        real.scrollIntoView({ block: "center" });
        // Scrolling-to-type implies focus — and the focused row is PINNED
        // against estimate-drift unmounts (EB-8 v1). "landed" MEANS focus
        // verified: the old click was accidentally load-bearing.
        const area = real.querySelector("textarea, [contenteditable='true']") as HTMLElement | null;
        area?.focus({ preventScroll: true });
        if (area && document.activeElement === area) return "landed";
        return "unfocused";
      }
    }
    return "still-ph";
  },
  marks: () =>
    Object.fromEntries(
      ["lab:visible", "lab:editable", "nq:visible", "nq:editable", "first-contentful-paint", "first-paint"].map((name) => [
        name,
        performance.getEntriesByName(name)[0]?.startTime ?? null,
      ]),
    ),
  textOf: (block: BlockId) => editor.view.blocks[block]?.text?.s ?? null,
  totalChars: () => lab.blockIds().reduce((n, id) => n + (editor.view.blocks[id]?.text?.s.length ?? 0), 0),
  focusLosses: () => focusLosses,
  /** Characters the local writer has in the document: the target block plus every block they created (Enter). */
  localChars: (target: BlockId) => {
    const view = editor.view;
    let n = view.blocks[target]?.text?.s.length ?? 0;
    for (const id of lab.blockIds()) {
      const block = view.blocks[id];
      if (id !== target && block?.attribution.created.actor === "human:lab") n += block.text?.s.length ?? 0;
    }
    return n;
  },
  hiddenCount: () => hiddenCount,
  /** The block at the top of the viewport: what scroll anchoring keeps in place (EB-7). */
  topVisibleBlock: () => {
    for (const row of Array.from(surface.element.querySelectorAll("[data-nq-block]"))) {
      if (row.getBoundingClientRect().bottom > 0) return row.getAttribute("data-nq-block");
    }
    return null;
  },
  /** Windowing-aware: mounted rows AND placeholders (EB-8). */
  blockIds: () => Array.from(surface.element.querySelectorAll("[data-nq-block]")).map((row) => row.getAttribute("data-nq-block")!),
  /** Every block id in document order, mounted or not (projection walk). */
  allBlockIds: () => {
    const view = editor.view, out: string[] = [];
    const walk = (ids: readonly string[]): void => { for (const id of ids) { const b = view.blocks[id]; if (!b) continue; out.push(id); walk(b.children); } };
    walk(view.roots);
    return out;
  },
  /** EB-6 observability: per-keystroke phase marks through the real pipeline. */
  phaseArm: () => {
    if ((globalThis as { __phased?: boolean }).__phased) return;
    (globalThis as { __phased?: boolean }).__phased = true;
    window.addEventListener("keydown", () => { const g = globalThis as { __pm?: Record<string, number> }; if (g.__pm && !g.__pm.keydownWindow) g.__pm.keydownWindow = performance.now(); if (!g.__pm) g.__pm = { keydownWindow: performance.now() }; }, true);
    document.addEventListener("keydown", () => { (globalThis as { __pm?: Record<string, number> }).__pm = { keydown: performance.now() }; }, true);
    document.addEventListener("input", () => { const pm = (globalThis as { __pm?: Record<string, number> }).__pm; if (pm) pm.input = performance.now(); }, true);
    editor.onEvents(() => { const pm = (globalThis as { __pm?: Record<string, number> }).__pm; if (pm) pm.tx = performance.now(); });
    editor.onChange(() => {
      const pm = (globalThis as { __pm?: Record<string, number> }).__pm; if (!pm) return;
      pm.change = performance.now();
      queueMicrotask(() => { pm.rendered = performance.now(); });
      requestAnimationFrame(() => { pm.frame = performance.now(); (globalThis as { __phases?: Record<string, number>[] }).__phases = [...((globalThis as { __phases?: Record<string, number>[] }).__phases ?? []), pm]; });
    });
  },
  phaseCollect: () => ((globalThis as { __phases?: Record<string, number>[] }).__phases ?? []).splice(0),
  /** EB-7 observability: the surface's remote-render and pin counters. */
  stats: () => ({ statsVersion: 3, remoteRenders: surface.remoteRenders, pins: surface.pins, lastAnchor: (surface as any).lastAnchor, lastDrift: (surface as any).lastDrift, lastAnchorRect: (surface as any).lastAnchorRect, lastViewportTop: (surface as any).lastViewportTop, renderCounts: surface.renderCounts }),
  /** Where focus and selection are, and where a given block sits on screen. */
  probe: (anchor: BlockId) => {
    const active = document.activeElement as HTMLTextAreaElement | null;
    const row = rowOf(anchor);
    return {
      focusedBlock: active?.closest("[data-nq-block]")?.getAttribute("data-nq-block") ?? null,
      selection: textSelection(active),
      anchorTop: row ? row.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
    };
  },
  /** A remote writer's transaction, as if it had just merged in (EB-7):
   *  applied through a shadow peer and merged as a REAL remote update —
   *  the production arrival path (non-local transaction), not editor.apply,
   *  which would look local to every observer. */
  remote: (op: Op) => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(editor.ydoc));
    applyTransaction(peer, { id: newBlockId(), actor: remoteActor, lamport: ++remoteLamport + 1_000_000, causality: {}, intent: "lab-remote", ops: [op] });
    const delta = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(editor.ydoc));
    Y.applyUpdate(editor.ydoc, delta, "lab-remote-merge");
  },
  /** EB-4 sync storm: the peer edits blocks other than `exclude`, `perSecond` times a second, through the relay. */
  startStorm: (exclude: BlockId, perSecond = 50) => {
    if (!peer) throw new Error("load the page with ?condition=sync-storm");
    const rand = random(0x5707);
    let n = 0;
    storm = setInterval(() => {
      const ids = lab.blockIds().filter((id) => id !== exclude);
      const block = ids[Math.floor(rand() * ids.length)]!;
      peer.editText(block, `${peer.view.blocks[block]?.text?.s ?? ""}${"storm "[n++ % 6]}`);
    }, 1000 / perSecond);
  },
  stopStorm: () => {
    if (storm) clearInterval(storm);
    storm = null;
  },
  /**
   * EB-7 in the page, so 10,000 transactions take minutes, not hours. The
   * caret sits at the end of `caret`'s block; every remote transaction
   * touches other blocks only. After each, the caret must still be in the
   * same block at the same offsets, and the block at the top of the viewport
   * must not have moved. After a focus violation the caret is put back, as
   * the writer would, so the other checks keep running.
   */
  fuzzRemote: async (options: { seed: number; ops: number; caret: BlockId }) => {
    const rand = random(options.seed);
    const input = () => rowOf(options.caret)?.querySelector<HTMLElement>('textarea, [contenteditable="true"]') ?? null;
    const restore = () => {
      const area = input();
      area?.focus();
      if (area instanceof HTMLTextAreaElement) area.setSelectionRange(area.value.length, area.value.length);
      else if (area) { const range = document.createRange(); range.selectNodeContents(area); range.collapse(false); document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range); }
    };
    const counts = { focus: 0, selection: 0, viewport: 0 };
    const first: { op: number; kind: string; detail: string }[] = [];
    const record = (op: number, kind: keyof typeof counts, detail: string) => {
      counts[kind]++;
      if (first.length < 8) first.push({ op, kind, detail });
    };
    const started = performance.now();
    for (let i = 0; i < options.ops; i++) {
      const active = document.activeElement as HTMLTextAreaElement | null;
      const selection = textSelection(active);
      if (!selection) throw new Error("Cannot measure EB-7 without a native text selection");
      const anchor = lab.topVisibleBlock();
      const anchorTop = anchor ? rowOf(anchor)!.getBoundingClientRect().top : null;
      const order = lab.blockIds();
      const others = order.filter((id) => id !== options.caret && id !== anchor);
      const pick = () => others[Math.floor(rand() * others.length)]!;
      const roll = rand();
      let op: Op;
      let expected: (number | null)[] | null = selection;
      if (roll < 0.3 || others.length < 5) {
        const s = `remote ${i}`;
        op = { op: "insert", block: { id: newBlockId(), type: "nooq.paragraph/v1", fields: {}, text: unmarked(s), children: [], attribution: { created: { actor: remoteActor.actorId }, fields: {} } }, parent: null, index: Math.floor(rand() * (order.length + 1)) };
      } else if (roll < 0.4) {
        op = { op: "textEdit", block: pick(), changes: [{ insert: `e${i} ` }] }; // DM-4.3: single-splice remote edits
      } else if (roll < 0.5 && selection && selection[0] === selection[1]) {
        // Inside the caret's own block: the caret must stay on the same characters.
        const length = editor.view.blocks[options.caret]?.text?.s.length ?? 0;
        const caretAt = selection[0]!;
        let at = Math.floor(rand() * (length + 1));
        if (at === caretAt) at = caretAt === 0 ? 1 : caretAt - 1;
        at = Math.min(at, length);
        expected = at < caretAt ? [caretAt + 2, caretAt + 2] : [caretAt, caretAt];
        op = { op: "textEdit", block: options.caret, changes: [...(at ? [{ retain: at }] : []), { insert: "··" }] };
      } else if (roll < 0.8) {
        op = { op: "delete", block: pick() };
      } else {
        op = { op: "move", block: pick(), newParent: null, index: Math.floor(rand() * order.length) };
      }
      lab.remote(op);
      await rendered();

      const now = document.activeElement as HTMLTextAreaElement | null;
      const focusedBlock = now?.closest("[data-nq-block]")?.getAttribute("data-nq-block") ?? null;
      if (focusedBlock !== options.caret) {
        record(i, "focus", `${op.op}: focus moved from the caret's block to ${focusedBlock ?? "nothing"}`);
        restore();
        continue;
      }
      const after = textSelection(now);
      if (JSON.stringify(after) !== JSON.stringify(expected)) {
        const where = op.op === "textEdit" && op.block === options.caret ? " in the caret's block" : "";
        record(i, "selection", `${op.op}${where}: expected selection ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`);
      }
      const anchorRow = anchor ? rowOf(anchor) : null;
      if (anchorRow && anchorTop !== null) {
        const moved = anchorRow.getBoundingClientRect().top - anchorTop;
        if (Math.abs(moved) >= 1) record(i, "viewport", `${op.op}: the block at the top of the viewport moved ${Math.round(moved)}px`);
      }
    }
    return { applied: options.ops, counts, first, seconds: Math.round((performance.now() - started) / 100) / 10, blocksAtEnd: lab.blockCount() };
  },
  /** Resolves after the editor has rendered and two frames have painted. */
  settle: () => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0)),
};

(window as unknown as { lab: typeof lab }).lab = lab;
if (peer) await new Promise<void>((resolve) => setTimeout(resolve, 0));
performance.mark("lab:readied");
document.documentElement.dataset.labReady = "true";
