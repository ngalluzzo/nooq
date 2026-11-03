/**
 * Reference documents (EB-3), generated deterministically from a seed:
 * the generator is versioned, never its output.
 *
 * v1 deviation: the reference editor has no list block yet, so lists are
 * stood in for by paragraphs. Revisit when a list block exists.
 */

import * as Y from "yjs";
import type { ActorDescriptor, Block, RenderedText, Transaction } from "@nooq/core";
import { applyTransaction, newDocument } from "@nooq/yjs";

export type RefDocName = "ref-small" | "ref-large" | "ref-huge" | "ref-tables";

const SPECS: Record<RefDocName, { blocks: number; seed: number; table?: { rows: number; columns: number } }> = {
  "ref-small": { blocks: 50, seed: 0x5eed01 },
  "ref-large": { blocks: 2000, seed: 0x5eed02 },
  "ref-huge": { blocks: 10000, seed: 0x5eed03 },
  // 0015's lab shape: 40 paragraphs around one 100-row x 8-column table
  // (901 blocks, ~942 with the shell) — table-heavy by construction.
  "ref-tables": { blocks: 40, seed: 0x5eed04, table: { rows: 100, columns: 8 } },
};

const ACTORS: ActorDescriptor[] = [
  { actorId: "human:maya", kind: "human" },
  { actorId: "human:tomas", kind: "human" },
  { actorId: "human:ines", kind: "human" },
  { actorId: "ai:rewrite", kind: "ai", model: "qwen3-8b" },
  { actorId: "importer:docx", kind: "importer" },
];

const WORDS =
  "the pilot ran for six weeks across four teams offline sync merged quietly every block keeps its identity writers moved paragraphs while the model proposed edits nobody waited on the network export kept the layout reviewers accepted most suggestions provenance stayed in the margin".split(
    " ",
  );

/** mulberry32: small, seedable, good enough for content. */
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

function idFor(seed: number, i: number): string {
  const hex = (seed * 1_000_003 + i).toString(16).padStart(12, "0").slice(-12);
  return `0192f4c8-0000-7000-8000-${hex}`;
}

function sentence(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]!);
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** About 10% of characters carry a mark, in runs (DM-3.3). */
function marked(rand: () => number, s: string): RenderedText {
  const marks: string[][] = [];
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    if (run === 0 && rand() < 0.012) run = 6 + Math.floor(rand() * 10);
    marks.push(run > 0 ? ["strong"] : []);
    if (run > 0) run--;
  }
  return { s, marks };
}

/** The transactions that build a reference document, in order. */
function tableTransactions(seed: number, spec: { rows: number; columns: number }, startIndex: number): { ops: import("@nooq/core").Op[]; cellIds: string[][] } {
  const rand = random(seed ^ 0x7ab1e);
  const ops: import("@nooq/core").Op[] = [];
  const cellIds: string[][] = [];
  const tableId = idFor(seed, startIndex), rowBase = startIndex + 1;
  ops.push({ op: "insert", block: { id: tableId, type: "nooq.table/v1", fields: {}, children: [], attribution: { created: { actor: ACTORS[0]!.actorId }, fields: {} } }, parent: null });
  for (let r = 0; r < spec.rows; r++) {
    const rowId = idFor(seed, rowBase + r);
    ops.push({ op: "insert", block: { id: rowId, type: "nooq.table-row/v1", fields: {}, children: [], attribution: { created: { actor: ACTORS[0]!.actorId }, fields: {} } }, parent: tableId, index: r });
    const rowCells: string[] = [];
    for (let c = 0; c < spec.columns; c++) {
      const cellId = idFor(seed, rowBase + spec.rows + r * spec.columns + c);
      const text = sentence(rand, 3 + Math.floor(rand() * 4));
      ops.push({ op: "insert", block: { id: cellId, type: "nooq.table-cell/v1", fields: {}, text: marked(rand, text), children: [], attribution: { created: { actor: ACTORS[0]!.actorId }, fields: {} } }, parent: rowId, index: c });
      rowCells.push(cellId);
    }
    cellIds.push(rowCells);
  }
  return { ops, cellIds };
}

export function refTransactions(name: RefDocName): Transaction[] {
  const { blocks, seed } = SPECS[name];
  if (name === "ref-tables") {
    const spec = SPECS[name]!.table!;
    const rand = random(seed);
    const txs: Transaction[] = [];
    for (let i = 0; i < blocks; i++) {
      const actor = ACTORS[Math.floor(rand() * ACTORS.length)]!;
      const s2 = sentence(rand, 14 + Math.floor(rand() * 8));
      txs.push({ id: idFor(seed ^ 0xff, i), actor, lamport: i + 1, causality: {}, intent: "ref-doc", ops: [{ op: "insert", block: { id: idFor(seed, i), type: "nooq.paragraph/v1", fields: {}, text: marked(rand, s2), children: [], attribution: { created: { actor: actor.actorId }, fields: {} } }, parent: null }] });
    }
    const { ops } = tableTransactions(seed, spec, blocks);
    txs.push({ id: idFor(seed ^ 0xfe, 0), actor: ACTORS[0]!, lamport: 1, causality: {}, intent: "ref-doc", ops });
    return txs;
  }
  const rand = random(seed);
  const lamports = new Map<string, number>();
  const txs: Transaction[] = [];
  for (let i = 0; i < blocks; i++) {
    const actor = ACTORS[Math.floor(rand() * ACTORS.length)]!;
    const heading = i % 12 === 0;
    const s = heading ? sentence(rand, 3 + Math.floor(rand() * 4)).slice(0, -1) : sentence(rand, 14 + Math.floor(rand() * 8));
    const block: Block = {
      id: idFor(seed, i),
      type: heading ? "nooq.heading/v1" : i % 29 === 7 ? "nooq.quote/v1" : "nooq.paragraph/v1",
      fields: {},
      text: marked(rand, s),
      children: [],
      attribution: { created: { actor: actor.actorId }, fields: {} },
    };
    const lamport = (lamports.get(actor.actorId) ?? 0) + 1;
    lamports.set(actor.actorId, lamport);
    txs.push({ id: idFor(seed ^ 0xff, i), actor, lamport, causality: {}, intent: "ref-doc", ops: [{ op: "insert", block, parent: null }] });
  }
  return txs;
}

export const refBlockId = (name: RefDocName, i: number) => idFor(SPECS[name].seed, i);

/** A table cell's id in ref-tables (deterministic; the lab's typing target). */
export function refTableCellId(row: number, column: number): string {
  const spec = SPECS["ref-tables"]!;
  const base = spec.blocks + 1 + spec.table!.rows;
  return idFor(spec.seed, base + row * spec.table!.columns + column);
}

/** The big table's id in ref-tables (the column-gesture target). */
export const refTableId = (): string => idFor(SPECS["ref-tables"]!.seed, SPECS["ref-tables"]!.blocks);

const cache = new Map<string, Uint8Array>();

/** The document as one Yjs update, ready to apply to an editor's doc before mounting. */
export function refUpdate(name: RefDocName, docId: string): Uint8Array {
  const key = `${name}:${docId}`;
  let update = cache.get(key);
  if (!update) {
    const doc = newDocument(docId);
    // One merged transaction: content-identical (fresh inserts, no LWW
    // conflicts, attribution rides each block) but validated and applied
    // once — per-tx replay was minutes at ref-huge's 10k blocks.
    const txs = refTransactions(name);
    doc.transact(() => {
      applyTransaction(doc, { id: txs[0]!.id, actor: txs[0]!.actor, lamport: 1, causality: {}, intent: "ref-doc", ops: txs.flatMap(tx => tx.ops) } as typeof txs[number], "refdoc-merged");
    });
    update = Y.encodeStateAsUpdate(doc);
    cache.set(key, update);
  }
  return update;
}
