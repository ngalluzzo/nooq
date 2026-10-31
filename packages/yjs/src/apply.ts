/**
 * Transaction application — DM-4 ops onto the Yjs layout (DM-9).
 *
 * Validation mirrors the sequential engine (engine.ts) via a fresh
 * projection per op, so multi-op transactions observe their own earlier
 * ops. Field values are written through a register wrapper
 * {nooq: "register/1", value, actor, lamport}; the discriminator key is
 * reserved and MUST NOT be used as the top level of a stored field value.
 */

import * as Y from "yjs";
import {
  liveTree,
  subtreeOf,
  validateRenderedText,
  type ActorId,
  type BlockId,
  type JsonValue,
  type RenderedText,
  type Transaction,
} from "@nooq/core";
import { REGISTER, layout, registerHeader } from "./layout.ts";
import type { TextChange } from "@nooq/core";
import { readState } from "./read.ts";

export function newDocument(docId: string, schemaVersion = 1): Y.Doc {
  const doc = new Y.Doc();
  registerHeader(doc, { docId, schemaVersion }); // side-channel: clocks 0+ stay for real content
  return doc;
}

/** Apply a nooq transaction to a Y.Doc. Durable intent is logged with the ops (DM-4). */
export function applyTransaction(doc: Y.Doc, tx: Transaction): void {
  doc.transact(() => {
    tx.ops.forEach((op, index) => {
      try {
        applyOp(doc, op, tx);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`transaction ${tx.id} op ${index} (${op.op}) failed: ${message}`);
      }
    });
    layout(doc).log.push([tx as unknown as Record<string, unknown>]);
  });
}

function applyOp(doc: Y.Doc, op: import("@nooq/core").Op, tx: Transaction): void {
  switch (op.op) {
    case "insert":
      return applyInsert(doc, op.block, op.parent, op.index, tx);
    case "setField": {
      const yb = requireYBlock(doc, op.block);
      (yb.get("fields") as Y.Map<unknown>).set(op.key, register(op.value, tx));
      return;
    }
    case "textEdit": {
      const yb = requireYBlock(doc, op.block);
      let yt = yb.get("text") as Y.Text | undefined;
      if (!yt) {
        yt = new Y.Text();
        yb.set("text", yt); // integrate before writing: Y.Text.format is unavailable on prelim types
      }
      applyChanges(yt, op.changes);
      yb.set("textBy", { actor: tx.actor.actorId, lamport: tx.lamport });
      return;
    }
    case "move":
      return applyMove(doc, op.block, op.newParent, op.index, tx);
    case "delete": {
      const view = readState(doc);
      if (!view.blocks[op.block]) throw new Error(`no such block ${op.block}`);
      if (!liveTree(view).alive.has(op.block)) throw new Error(`block ${op.block} is tombstoned`);
      detachEverywhere(doc, op.block);
      layout(doc).placement.set(op.block, {
        parent: null,
        lamport: tx.lamport,
        actor: tx.actor.actorId,
        tombstoned: true,
      });
      return;
    }
    case "restore": {
      const view = readState(doc);
      if (!view.blocks[op.block]) throw new Error(`no such block ${op.block}`);
      if (liveTree(view).alive.has(op.block)) throw new Error(`block ${op.block} is not tombstoned`);
      if (op.parent !== null) {
        checkParent(doc, op.parent);
        if (subtreeOf(view, op.block).has(op.parent)) {
          throw new Error("cannot restore a block into its own subtree (DM-3.1)");
        }
      }
      attach(doc, op.block, op.parent, op.index, tx);
      return;
    }
  }
}

function register(value: JsonValue, tx: Transaction): import("./layout.ts").Register {
  return { nooq: REGISTER, value: structuredClone(value), actor: tx.actor.actorId, lamport: tx.lamport };
}

function requireYBlock(doc: Y.Doc, id: BlockId): Y.Map<unknown> {
  const yb = layout(doc).blocks.get(id);
  if (!yb) throw new Error(`no such block ${id}`);
  return yb;
}

function checkParent(doc: Y.Doc, parent: BlockId | null): void {
  if (parent === null) return;
  const view = readState(doc);
  if (!view.blocks[parent]) throw new Error(`no such block ${parent}`);
  if (!liveTree(view).alive.has(parent)) throw new Error(`block ${parent} is tombstoned`);
}

function applyInsert(
  doc: Y.Doc,
  block: import("@nooq/core").Block,
  parent: BlockId | null,
  index: number | undefined,
  tx: Transaction,
): void {
  const { blocks } = layout(doc);
  if (blocks.has(block.id)) throw new Error(`block ${block.id} already exists`);
  for (const child of block.children) {
    if (!blocks.has(child)) throw new Error(`no such block ${child}`);
  }
  checkParent(doc, parent);

  // Integrate first, populate second: writes on unintegrated (prelim)
  // Yjs types are buffered and unsupported for some operations (Y.Text.format).
  const yblock = new Y.Map<unknown>();
  blocks.set(block.id, yblock);
  yblock.set("type", block.type);
  const yfields = new Y.Map<unknown>();
  yblock.set("fields", yfields);
  // Raw initial values (no register wrapper): engine parity — insert does
  // not attribute per-field writers for initial content.
  for (const [key, value] of Object.entries(block.fields)) yfields.set(key, structuredClone(value));
  yblock.set("children", new Y.Array<BlockId>());
  yblock.set("createdBy", block.attribution.created.actor);
  if (block.text !== undefined) {
    const yt = new Y.Text();
    yblock.set("text", yt);
    setText(yt, block.text); // after integration: format needs an integrated Y.Text
  }
  attach(doc, block.id, parent, index, tx);
}

function applyMove(
  doc: Y.Doc,
  id: BlockId,
  newParent: BlockId | null,
  index: number | undefined,
  tx: Transaction,
): void {
  const view = readState(doc);
  const alive = liveTree(view).alive;
  if (!view.blocks[id]) throw new Error(`no such block ${id}`);
  if (!alive.has(id)) throw new Error(`block ${id} is tombstoned`);
  if (newParent === id) throw new Error("cannot move a block under itself");
  if (newParent !== null) {
    if (!view.blocks[newParent]) throw new Error(`no such block ${newParent}`);
    if (!alive.has(newParent)) throw new Error(`block ${newParent} is tombstoned`);
    if (subtreeOf(view, id).has(newParent)) {
      throw new Error("cannot move a block into its own subtree (DM-3.1)");
    }
  }
  detachEverywhere(doc, id);
  attach(doc, id, newParent, index, tx);
}

function attach(doc: Y.Doc, id: BlockId, parent: BlockId | null, index: number | undefined, tx: Transaction): void {
  const { roots, blocks, placement } = layout(doc);
  const container =
    parent === null
      ? roots
      : (blocks.get(parent)!.get("children") as Y.Array<BlockId>);
  const at = Math.min(index ?? container.length, container.length);
  container.insert(at, [id]);
  placement.set(id, { parent, lamport: tx.lamport, actor: tx.actor.actorId });
}

/** Remove every physical occurrence of id from roots and all children arrays (handles strays). */
function detachEverywhere(doc: Y.Doc, id: BlockId): void {
  const { roots, blocks } = layout(doc);
  removeAll(roots, id);
  for (const yb of blocks.values()) {
    const children = yb.get("children") as Y.Array<BlockId> | undefined;
    if (children) removeAll(children, id);
  }
}

function removeAll(arr: Y.Array<BlockId>, id: BlockId): void {
  for (let i = arr.toArray().indexOf(id); i >= 0; i = arr.toArray().indexOf(id)) arr.delete(i, 1);
}

/** DM-4.3: apply splice steps to a Y.Text. Marks on inserts become per-character attributes; setMarks formats the range. */
export function applyChanges(yt: Y.Text, changes: readonly TextChange[]): void {
  let position = 0;
  for (const change of changes) {
    if ("retain" in change) {
      if ("setMarks" in change) {
        const target = change.setMarks === null ? [] : [...new Set(change.setMarks)].sort();
        const attrs: Record<string, true | null> = {};
        for (const mark of new Set([...marksInRange(yt, position, change.retain), ...target])) {
          attrs[mark] = target.includes(mark) ? true : null;
        }
        if (Object.keys(attrs).length > 0) yt.format(position, change.retain, attrs);
      }
      position += change.retain;
    } else if ("insert" in change) {
      const set = [...new Set(change.marks ?? [])].sort();
      const attrs: Record<string, true> = {};
      for (const mark of set) attrs[mark] = true;
      yt.insert(position, change.insert, set.length > 0 ? attrs : undefined);
      position += change.insert.length;
    } else if ("delete" in change) {
      yt.delete(position, change.delete);
    }
  }
}

function marksInRange(yt: Y.Text, from: number, length: number): string[] {
  const names = new Set<string>();
  let cursor = 0;
  for (const run of yt.toDelta() as unknown as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    const str = typeof run.insert === "string" ? run.insert : "";
    const attrs = run.attributes ?? {};
    if (cursor + str.length > from && cursor < from + length) {
      for (const name of Object.keys(attrs)) if (attrs[name]) names.add(name);
    }
    cursor += str.length;
  }
  return [...names];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Write rendered content into a Y.Text: insert runs, then format runs (per-character marks, DM-3.3). */
export function setText(yt: Y.Text, text: RenderedText): void {
  validateRenderedText(text);
  yt.delete(0, yt.length);
  let start = 0;
  while (start < text.s.length) {
    const set = text.marks[start]!;
    let end = start + 1;
    while (end < text.s.length && sameSet(text.marks[end]!, set)) end++;
    yt.insert(yt.length, text.s.slice(start, end));
    start = end;
  }
  start = 0;
  while (start < text.s.length) {
    const set = text.marks[start]!;
    let end = start + 1;
    while (end < text.s.length && sameSet(text.marks[end]!, set)) end++;
    if (set.length > 0) {
      const attrs: Record<string, true> = {};
      for (const mark of set) attrs[mark] = true;
      yt.format(start, end - start, attrs);
    }
    start = end;
  }
}
