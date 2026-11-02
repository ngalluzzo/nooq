/**
 * The lab page: mounts the reference editor on a reference document and
 * reports what the harness needs. It only observes; it never helps the
 * editor (no focusing on its behalf, no marks it should emit itself).
 *
 * `?condition=sync-storm` connects the editor to an in-page relay with a
 * second peer that edits other blocks at a steady rate (EB-4).
 */

import * as Y from "yjs";
import { applyTransaction, MaintainedProjection, newDocument } from "@nooq/yjs";
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

const rowOf = (block: BlockId) => surface.element.querySelector<HTMLElement>(`[data-nq-block="${block}"]:not([data-nq-ph])`);
const unmarked = (s: string) => ({ s, marks: Array.from({ length: s.length }, () => [] as string[]) });
/** The editor renders in microtasks; one macrotask later its DOM is current. */
const rendered = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Inspect native selection in either presentation; a missing range is not a passing probe. */
function textSelection(element: Element | null): [number, number] | null {
  if (element instanceof HTMLTextAreaElement) return element.selectionDirection === "backward" ? [element.selectionEnd, element.selectionStart] : [element.selectionStart, element.selectionEnd];
  const selection = document.getSelection();
  if (!(element instanceof HTMLElement) || !element.isContentEditable || !selection?.anchorNode || !selection.focusNode
    || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null;
  const offset = (node: Node, at: number) => { const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, at); return range.toString().length; };
  return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)];
}

let storm: ReturnType<typeof setInterval> | null = null;

/** Helpers the harness calls through view.evaluate(). */
interface Replica { doc: Y.Doc; projection: MaintainedProjection }
interface Delivery { op: Op; send(): void }
let remotePeer: Replica | undefined, competingPeer: Replica | undefined;
const competingActor = { actorId: "human:remote-b", kind: "human" as const };
const seen: Record<string, number> = {};
function makeReplica(): Replica {
  const doc = newDocument(DOC_ID); // retain tombstones and disable Yjs format cleanup (DM-12)
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(editor.ydoc));
  return { doc, projection: new MaintainedProjection(doc) };
}
function syncReplica(replica: Replica): void {
  Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(editor.ydoc, Y.encodeStateVector(replica.doc)));
  replica.projection.sync();
}
function primaryReplica(): Replica {
  if (!remotePeer) {
    remotePeer = makeReplica();
    for (const tx of editor.history()) seen[tx.actor.actorId] = Math.max(seen[tx.actor.actorId] ?? 0, tx.lamport);
  }
  return remotePeer;
}
function author(replica: Replica, op: Op, actor: typeof remoteActor, lamport: number, causality: Record<string, number>): void {
  applyTransaction(replica.doc, { id: newBlockId(), actor, lamport, causality, intent: "lab-remote", ops: [op] }, undefined, undefined, replica.projection.value);
  replica.projection.sync();
}
function singleRemote(op: Op): Delivery {
  const replica = primaryReplica();
  syncReplica(replica);
  const lamport = ++remoteLamport + 1_000_000;
  author(replica, op, remoteActor, lamport, { ...seen });
  seen[remoteActor.actorId] = lamport;
  const delta = Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(editor.ydoc));
  return { op, send: () => Y.applyUpdate(editor.ydoc, delta, "lab-remote-merge") };
}
function sameFrontier(a: Y.Doc, b: Y.Doc): boolean {
  const left = Y.decodeStateVector(Y.encodeStateVector(a)), right = Y.decodeStateVector(Y.encodeStateVector(b));
  return left.size === right.size && [...left].every(([client, clock]) => right.get(client) === clock);
}
/** Author both conflicting moves BEFORE either update reaches the recipient. */
function concurrentRemote(block: BlockId, first: number, second: number, reverse: boolean) {
  const a = primaryReplica(), b = competingPeer ??= makeReplica();
  syncReplica(a); syncReplica(b);
  if (!sameFrontier(a.doc, b.doc) || !sameFrontier(a.doc, editor.ydoc)) throw new Error("Concurrent moves must fork at the same causal frontier");
  const frontier = Y.encodeStateVector(editor.ydoc), causality = { ...seen };
  const lamport = ++remoteLamport + 1_000_000;
  const opA: Op = { op: "move", block, newParent: null, index: first };
  const opB: Op = { op: "move", block, newParent: null, index: second };
  author(a, opA, remoteActor, lamport, causality);
  author(b, opB, competingActor, lamport, causality);
  const deltaA = Y.encodeStateAsUpdate(a.doc, frontier), deltaB = Y.encodeStateAsUpdate(b.doc, frontier);
  const deliveries: Delivery[] = [
    { op: opA, send: () => Y.applyUpdate(editor.ydoc, deltaA, "lab-concurrent-a") },
    { op: opB, send: () => Y.applyUpdate(editor.ydoc, deltaB, "lab-concurrent-b") },
  ];
  return {
    deliveries: reverse ? deliveries.reverse() : deliveries,
    finish: () => {
      // A saw A→B; B saw B→A. Both must agree with either recipient order.
      syncReplica(a); syncReplica(b);
      seen[remoteActor.actorId] = seen[competingActor.actorId] = lamport;
      const roots = editor.view.roots;
      return sameFrontier(a.doc, b.doc) && sameFrontier(a.doc, editor.ydoc)
        && roots.filter(id => id === block).length === 1 && new Set(roots).size === roots.length
        && JSON.stringify(a.projection.value.roots) === JSON.stringify(roots)
        && JSON.stringify(b.projection.value.roots) === JSON.stringify(roots)
        && JSON.stringify(a.projection.value.blocks[block]?.text) === JSON.stringify(editor.view.blocks[block]?.text)
        && JSON.stringify(b.projection.value.blocks[block]?.text) === JSON.stringify(editor.view.blocks[block]?.text);
    },
  };
}
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
  topVisibleBlock: (liveIds: readonly string[] = lab.allBlockIds()): string | null => {
    const live = new Set(liveIds);
    for (const row of Array.from(surface.element.querySelectorAll("[data-nq-block]"))) {
      const id = row.getAttribute("data-nq-block")!;
      if (!live.has(id) || row.hasAttribute("data-nq-ph")) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) return id;
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
  remote: (op: Op) => singleRemote(op).send(),
  selectText: (block: BlockId, anchor: number, head: number) => {
    const area = rowOf(block)?.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
    if (!area) throw new Error("Cannot select an unmounted text block");
    area.focus({ preventScroll: true });
    if (area instanceof HTMLTextAreaElement) area.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
    else {
      const point = (offset: number): [Node, number] => {
        const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) { if (offset <= node.textContent!.length) return [node, offset]; offset -= node.textContent!.length; }
        return [area, area.childNodes.length];
      };
      const [a, x] = point(anchor), [b, y] = point(head);
      document.getSelection()!.setBaseAndExtent(a, x, b, y);
    }
  },
  /** Initial native selection setup, independent of each backend's End-key semantics. */
  placeCaretAtEnd: (block: BlockId) => {
    const area = rowOf(block)?.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
    if (!area) throw new Error("Cannot place a caret in an unmounted text block");
    area.focus({ preventScroll: true });
    if (area instanceof HTMLTextAreaElement) area.setSelectionRange(area.value.length, area.value.length);
    else { const range = document.createRange(); range.selectNodeContents(area); range.collapse(false); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); }
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
  /** EB-7: check EACH delivered transaction, including both concurrent arrivals. */
  fuzzRemote: async (options: { seed: number; ops: number; caret: BlockId }) => {
    let caret = options.caret;
    const rand = random(options.seed);
    const counts = { focus: 0, selection: 0, viewport: 0, convergence: 0 };
    const viewportChecks = { anchored: 0, noVisibleOrigin: 0, noRenderedFallback: 0 };
    const coverage = { insert: 0, edit: 0, caretInsert: 0, delete: 0, restore: 0, move: 0, marks: 0, caretMarks: 0, otherMarks: 0, concurrentMoves: 0, concurrentPairs: 0, aFirst: 0, bFirst: 0, charDelete: 0, deleteBefore: 0, deleteInside: 0, deleteCovered: 0, deleteOther: 0, caretMove: 0, caretDelete: 0, caretConcurrentPairs: 0, selectionForward: 0, selectionBackward: 0, selectionCollapsed: 0, emptyUpdates: 0 };
    const first: { op: number; kind: keyof typeof counts; detail: string }[] = [];
    const dead = new Set<BlockId>();
    const record = (op: number, kind: keyof typeof counts, detail: string) => {
      counts[kind]++;
      if (first.length < 8) { first.push({ op, kind, detail }); console.error(`[EB-7 ${textMode} seed ${options.seed}] ${JSON.stringify({ op, kind, detail })}`); }
    };
    // This prefix makes every family and both delivery orders non-vacuous even in short probes.
    const prefix = ["insert", "caretMarks", "otherMarks", "delete", "restore", "aFirst", "edit", "caretInsert", "move", "bFirst", "charDeleteBefore", "charDeleteInside", "caretInsert", "charDeleteOther", "caretMove", "caretConcurrent", "caretDelete", "caretInsert", "charDeleteCover"] as const;
    const choices = ["insert", "delete", "delete", "delete", "restore", "restore", "move", "concurrent", "marks", "marks", "caretInsert", "edit", "charDeleteBefore", "charDeleteInside", "charDeleteCover", "charDeleteOther", "caretMove", "caretDelete", "caretConcurrent"] as const;
    const started = performance.now();
    let applied = 0, round = 0, anchorChanges = 0;
    while (applied < options.ops) {
      const order = lab.allBlockIds(), others = order.filter(id => id !== caret);
      const pick = () => others[Math.floor(rand() * others.length)]!;
      const pickText = () => { const ids = others.filter(id => (editor.view.blocks[id]?.text?.s.length ?? 0) > 0); return ids[Math.floor(rand() * ids.length)] ?? caret; };
      let kind: string = prefix[round] ?? choices[Math.floor(rand() * choices.length)]!;
      if (others.length < 5) kind = "insert";
      if (kind === "restore" && dead.size === 0) kind = "delete";
      if ((kind === "concurrent" || kind === "caretConcurrent" || kind === "aFirst" || kind === "bFirst") && options.ops - applied < 2) kind = "move";
      const size = editor.view.blocks[caret]!.text!.s.length;
      if (size < 32) kind = "caretInsert";
      const low = size > 5 ? 2 + Math.floor(rand() * (size - 5)) : 0;
      const high = size > 5 ? Math.min(size, low + 3 + Math.floor(rand() * (size - low - 2))) : size;
      const shape = kind.startsWith("charDelete") ? 1 + round % 2 : round % 3;
      const requested = [shape === 2 ? high : low, shape === 1 ? high : low];
      Y.applyUpdate(editor.ydoc, new Uint8Array([0, 0]), "lab-empty-remote"); coverage.emptyUpdates++;
      lab.selectText(caret, requested[0]!, requested[1]!);
      if (JSON.stringify(textSelection(document.activeElement)) !== JSON.stringify(requested)) throw new Error("Native selection setup did not land");
      let op: Op;
      let effect: { at: number; inserted: number; removed: number } | undefined;
      let markCheck: { block: BlockId; from: number; length: number; marks: string[]; text: string } | undefined;
      let finish: (() => boolean) | undefined;
      let deliveries: Delivery[] | undefined;
      let counter: "insert" | "edit" | "caretInsert" | "delete" | "restore" | "move" | "marks" | "concurrentMoves" | "charDelete" | "caretMove" | "caretDelete";
      if (kind === "insert") {
        const s = `remote ${round}`;
        op = { op: "insert", block: { id: newBlockId(), type: "nooq.paragraph/v1", fields: {}, text: unmarked(s), children: [], attribution: { created: { actor: remoteActor.actorId }, fields: {} } }, parent: null, index: Math.floor(rand() * (order.length + 1)) };
        counter = "insert";
      } else if (kind === "delete") {
        op = { op: "delete", block: pick() }; counter = "delete";
      } else if (kind === "restore") {
        const ids = [...dead];
        op = { op: "restore", block: ids[Math.floor(rand() * ids.length)]!, parent: null, index: Math.floor(rand() * (order.length + 1)) }; counter = "restore";
      } else if (kind === "caretDelete") {
        op = { op: "delete", block: caret }; counter = "caretDelete";
      } else if (kind === "caretMove") {
        const index = (order.indexOf(caret) + 1 + Math.floor(rand() * (order.length - 1))) % order.length;
        op = { op: "move", block: caret, newParent: null, index }; counter = "caretMove";
      } else if (kind.startsWith("charDelete")) {
        const block = kind === "charDeleteOther" ? pickText() : caret;
        const length = editor.view.blocks[block]!.text!.s.length;
        const selected = textSelection(document.activeElement)!;
        const lo = Math.min(...selected), hi = Math.max(...selected);
        const at = kind === "charDeleteBefore" ? 0 : kind === "charDeleteCover" ? Math.max(0, lo - 1) : kind === "charDeleteOther" ? Math.floor(rand() * length) : lo + 1;
        const removed = kind === "charDeleteBefore" ? Math.max(1, lo) : kind === "charDeleteCover" ? Math.min(length, hi + 1) - at : 1;
        op = { op: "textEdit", block, changes: [...(at ? [{ retain: at }] : []), { delete: removed }] };
        if (block === caret) effect = { at, inserted: 0, removed };
        coverage[kind === "charDeleteBefore" ? "deleteBefore" : kind === "charDeleteCover" ? "deleteCovered" : kind === "charDeleteOther" ? "deleteOther" : "deleteInside"]++;
        counter = "charDelete";
      } else if (kind === "move") {
        op = { op: "move", block: pick(), newParent: null, index: Math.floor(rand() * order.length) }; counter = "move";
      } else if (kind === "concurrent" || kind === "caretConcurrent" || kind === "aFirst" || kind === "bFirst") {
        const block = kind === "caretConcurrent" ? caret : pick(), a = Math.floor(rand() * order.length);
        let b = Math.floor(rand() * order.length); if (b === a) b = (a + 1) % order.length;
        const reverse = kind === "bFirst" || (kind === "concurrent" || kind === "caretConcurrent") && rand() < 0.5;
        const fork = concurrentRemote(block, a, b, reverse);
        deliveries = fork.deliveries; finish = fork.finish;
        coverage.concurrentPairs++; if (block === caret) coverage.caretConcurrentPairs++; coverage[reverse ? "bFirst" : "aFirst"]++;
        counter = "concurrentMoves";
        op = deliveries[0]!.op;
      } else if (kind === "marks" || kind === "caretMarks" || kind === "otherMarks") {
        const onCaret = kind === "caretMarks" || kind === "marks" && rand() < 0.5;
        const block = onCaret ? caret : pickText(), text = editor.view.blocks[block]!.text!;
        const from = Math.floor(rand() * text.s.length), length = 1 + Math.floor(rand() * (text.s.length - from));
        const marks = text.marks[from]?.includes("strong") ? [] : ["strong"];
        op = { op: "textEdit", block, changes: [...(from ? [{ retain: from }] : []), { retain: length, setMarks: marks.length ? marks : null }] };
        markCheck = { block, from, length, marks, text: text.s };
        coverage[onCaret ? "caretMarks" : "otherMarks"]++;
        counter = "marks";
      } else if (kind === "caretInsert") {
        const selection = textSelection(document.activeElement);
        if (!selection) throw new Error("Cannot measure EB-7 without a native text selection");
        const length = editor.view.blocks[caret]!.text!.s.length;
        const chance = rand(), lo = Math.min(...selection), hi = Math.max(...selection);
        const at = chance < 0.25 ? lo : chance < 0.5 ? hi : Math.floor(rand() * (length + 1));
        const inserted = length < 32 ? "repeated ·· text for native selection ".repeat(4) : "··";
        op = { op: "textEdit", block: caret, changes: [...(at ? [{ retain: at }] : []), { insert: inserted }] };
        effect = { at, inserted: inserted.length, removed: 0 }; counter = "caretInsert";
      } else {
        op = { op: "textEdit", block: pick(), changes: [{ insert: `e${round} ` }] }; counter = "edit";
      }
      deliveries ??= [singleRemote(op)];
      for (const delivery of deliveries) {
        const selection = textSelection(document.activeElement);
        if (!selection) throw new Error("Cannot measure EB-7 without a native text selection");
        coverage[selection[0] === selection[1] ? "selectionCollapsed" : selection[0] < selection[1] ? "selectionForward" : "selectionBackward"]++;
        const beforeOrder = lab.allBlockIds(), top = lab.topVisibleBlock(beforeOrder);
        const changesTop = top !== null && "block" in delivery.op && delivery.op.block === top;
        if (changesTop) anchorChanges++;
        let anchor = top;
        if (changesTop) {
          const live = new Set(beforeOrder);
          const mounted = Array.from(surface.element.querySelectorAll<HTMLElement>('[data-nq-block]:not([data-nq-ph])'))
            .filter(row => live.has(row.dataset.nqBlock!) && row.getBoundingClientRect().bottom > 0);
          const at = mounted.findIndex(row => row.dataset.nqBlock === top);
          anchor = mounted.slice(at + 1).find(row => row.dataset.nqBlock !== top)?.dataset.nqBlock ?? null;
        }
        viewportChecks[top === null ? "noVisibleOrigin" : anchor === null ? "noRenderedFallback" : "anchored"]++;
        const anchorTop = anchor ? rowOf(anchor)?.getBoundingClientRect().top ?? null : null;
        const scrollBefore = window.scrollY;
        let expected = effect ? selection.map(p => {
          if (effect!.removed) return p <= effect!.at ? p : Math.max(effect!.at, p - effect!.removed);
          const right = selection[0] !== selection[1] && p === Math.min(...selection);
          return effect!.at < p || effect!.at === p && right ? p + effect!.inserted : p;
        }) : selection;
        if (delivery.op.op === "delete" && delivery.op.block === caret) {
          const at = beforeOrder.indexOf(caret), next = beforeOrder[at + 1], previous = beforeOrder[at - 1];
          caret = next ?? previous!;
          const offset = next ? 0 : editor.view.blocks[caret]!.text!.s.length;
          expected = [offset, offset];
        }
        delivery.send();
        coverage[counter]++;
        if (delivery.op.op === "delete") dead.add(delivery.op.block);
        if (delivery.op.op === "restore") dead.delete(delivery.op.block);
        await rendered();
        const now = document.activeElement;
        const focusedBlock = now?.closest("[data-nq-block]")?.getAttribute("data-nq-block") ?? null;
        if (focusedBlock !== caret) {
          record(applied, "focus", `${kind}: focus moved to ${focusedBlock ?? "nothing"}`);
          lab.placeCaretAtEnd(caret);
        } else {
          const after = textSelection(now);
          if (JSON.stringify(after) !== JSON.stringify(expected)) record(applied, "selection", `${kind}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`);
        }
        const anchorRow = anchor ? rowOf(anchor) : null;
        if (top === null && surface.lastAnchor !== null) record(applied, "viewport", `${kind}: renderer selected an anchor without a visible origin`);
        if (anchorTop !== null) {
          if (!anchorRow) record(applied, "viewport", `${kind}: unchanged anchor ${anchor} disappeared`);
          else {
            const moved = anchorRow.getBoundingClientRect().top - anchorTop;
            if (Math.abs(moved) >= 1) record(applied, "viewport", JSON.stringify({ remote: delivery.op, kind, top, anchor, beforeTop: anchorTop, afterTop: anchorRow.getBoundingClientRect().top, moved, scrollBefore, scrollAfter: window.scrollY, stats: lab.stats() }));
          }
        }
        if (delivery.op.op === "restore" && !editor.view.roots.includes(delivery.op.block)) record(applied, "convergence", "Restore did not make its tombstone live");
        if (markCheck) {
          const text = editor.view.blocks[markCheck.block]!.text!;
          if (text.s !== markCheck.text || text.marks.slice(markCheck.from, markCheck.from + markCheck.length).some(m => JSON.stringify(m) !== JSON.stringify(markCheck!.marks))) record(applied, "convergence", "Mark change was lost or changed characters");
        }
        applied++;
        if (applied % 250 === 0) console.info(`[EB-7 ${textMode} seed ${options.seed}] ${applied}/${options.ops} remote transactions; violations ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
      }
      if (finish && !finish()) record(applied - 1, "convergence", "Concurrent moves did not converge to one placement on both forked replicas and the editor");
      round++;
    }
    return { applied, anchorChanges, viewportChecks, coverage, counts, first, seconds: Math.round((performance.now() - started) / 100) / 10, blocksAtEnd: lab.blockCount() };
  },
  /** Resolves after the editor has rendered and two frames have painted. */
  settle: () => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0)),
};

(window as unknown as { lab: typeof lab }).lab = lab;
if (peer) await new Promise<void>((resolve) => setTimeout(resolve, 0));
performance.mark("lab:readied");
document.documentElement.dataset.labReady = "true";
