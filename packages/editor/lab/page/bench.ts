/**
 * The lab page: mounts the reference editor on a reference document and
 * reports what the harness needs. It only observes; it never helps the
 * editor (no focusing on its behalf, no marks it should emit itself).
 *
 * `?condition=sync-storm` connects the editor to an in-page relay with a
 * second peer that edits other blocks at a steady rate (EB-4).
 */

import * as Y from "yjs";
import { newBlockId, type BlockId, type Op } from "@nooq/core";
import { NooqRelay } from "@nooq/sync";
import { Editor } from "../../src/controller.ts";
import { createSurface } from "../../src/dom.ts";

const params = new URLSearchParams(location.search);
const docName = params.get("doc") ?? "ref-small";
const condition = params.get("condition") ?? "idle";
const DOC_ID = `lab-${docName}`;

const relay = condition === "sync-storm" ? new NooqRelay() : null;
const editor = new Editor({
  docId: DOC_ID,
  actor: { actorId: "human:lab", name: "Lab writer" },
  ...(relay ? { transport: relay.connect(DOC_ID) } : {}),
});
const update = new Uint8Array(await (await fetch(`/doc/${docName}?id=${DOC_ID}`)).arrayBuffer());
Y.applyUpdate(editor.ydoc, update);
const peer = relay ? new Editor({ docId: DOC_ID, actor: { actorId: "human:storm", name: "Storm" }, transport: relay.connect(DOC_ID) }) : null;
const surface = createSurface(editor);
document.getElementById("root")!.append(surface.element);

/**
 * Harness-observed marks, standing in until the editor emits nq:visible and
 * nq:editable itself (EB-5). "Visible": the first frame with block rows.
 * "Editable": the first frame where focus is inside the editor, with no help.
 */
let frames = 0;
function observe(): void {
  frames++;
  const rows = surface.element.querySelectorAll("[data-nq-block]").length;
  if (rows > 0 && performance.getEntriesByName("lab:visible").length === 0) performance.mark("lab:visible");
  if (surface.element.contains(document.activeElement) && performance.getEntriesByName("lab:editable").length === 0) {
    performance.mark("lab:editable");
    return;
  }
  if (frames < 240) requestAnimationFrame(observe);
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

let storm: ReturnType<typeof setInterval> | null = null;

/** Helpers the harness calls through view.evaluate(). */
const lab = {
  docName,
  condition,
  blockCount: () => surface.element.querySelectorAll("[data-nq-block]").length,
  marks: () =>
    Object.fromEntries(
      ["lab:visible", "lab:editable", "nq:visible", "nq:editable", "first-contentful-paint", "first-paint"].map((name) => [
        name,
        performance.getEntriesByName(name)[0]?.startTime ?? null,
      ]),
    ),
  textOf: (block: BlockId) => editor.view.blocks[block]?.text?.s ?? null,
  totalChars: () => Array.from(surface.element.querySelectorAll("textarea")).reduce((n, t) => n + t.value.length, 0),
  focusLosses: () => focusLosses,
  hiddenCount: () => hiddenCount,
  /** The block at the top of the viewport: what scroll anchoring keeps in place (EB-7). */
  topVisibleBlock: () => {
    for (const row of Array.from(surface.element.querySelectorAll("[data-nq-block]"))) {
      if (row.getBoundingClientRect().bottom > 0) return row.getAttribute("data-nq-block");
    }
    return null;
  },
  blockIds: () => Array.from(surface.element.querySelectorAll("[data-nq-block]")).map((row) => row.getAttribute("data-nq-block")!),
  /** Where focus and selection are, and where a given block sits on screen. */
  probe: (anchor: BlockId) => {
    const active = document.activeElement as HTMLTextAreaElement | null;
    const row = rowOf(anchor);
    return {
      focusedBlock: active?.closest("[data-nq-block]")?.getAttribute("data-nq-block") ?? null,
      selection: active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null,
      anchorTop: row ? row.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
    };
  },
  /** A remote writer's transaction, as if it had just merged in (EB-7). */
  remote: (op: Op) => {
    editor.apply({ id: newBlockId(), actor: remoteActor, lamport: ++remoteLamport + 1_000_000, causality: {}, intent: "lab-remote", ops: [op] });
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
    const textarea = () => rowOf(options.caret)?.querySelector("textarea") ?? null;
    const restore = () => {
      const area = textarea();
      area?.focus();
      area?.setSelectionRange(area.value.length, area.value.length);
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
      const selection = active?.selectionStart !== undefined ? [active.selectionStart, active.selectionEnd] : null;
      const anchor = lab.topVisibleBlock();
      const anchorTop = anchor ? rowOf(anchor)!.getBoundingClientRect().top : null;
      const order = lab.blockIds();
      const others = order.filter((id) => id !== options.caret && id !== anchor);
      const pick = () => others[Math.floor(rand() * others.length)]!;
      const roll = rand();
      let op: Op;
      if (roll < 0.3 || others.length < 5) {
        const s = `remote ${i}`;
        op = { op: "insert", block: { id: newBlockId(), type: "nooq.paragraph/v1", fields: {}, text: unmarked(s), children: [], attribution: { created: { actor: remoteActor.actorId }, fields: {} } }, parent: null, index: Math.floor(rand() * (order.length + 1)) };
      } else if (roll < 0.5) {
        op = { op: "textEdit", block: pick(), replace: unmarked(`edited ${i}`) };
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
      const after = [now!.selectionStart, now!.selectionEnd];
      if (JSON.stringify(after) !== JSON.stringify(selection)) record(i, "selection", `${op.op}: selection ${JSON.stringify(selection)} → ${JSON.stringify(after)}`);
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
document.documentElement.dataset.labReady = "true";
