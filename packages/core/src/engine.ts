/**
 * Reference transaction reducer — DM-4, sequential (single-peer) v0.
 *
 * This is the boring sequential engine for tests, tools, and importers.
 * The CRDT merge layer (DM-4.7/4.8) arrives with the Yjs adapter; it
 * consumes the same ops, so nothing here is throwaway.
 */

import type {
  ActorId,
  Block,
  BlockId,
  DocState,
  Op,
  RenderedText,
  Transaction,
} from "./model.ts";
import { liveTree, subtreeOf } from "./tree.ts";

export function emptyDocument(docId: string): DocState {
  return { docId, schemaVersion: 1, roots: [], blocks: {}, log: [] };
}

export function newBlockId(): BlockId {
  return crypto.randomUUID();
}

export interface MakeBlockInit {
  id?: BlockId;
  type: string;
  fields?: Record<string, import("./model.ts").JsonValue>;
  text?: RenderedText;
  children?: BlockId[];
}

export function makeBlock(init: MakeBlockInit, actor: ActorId): Block {
  return {
    id: init.id ?? newBlockId(),
    type: init.type,
    fields: structuredClone(init.fields ?? {}),
    ...(init.text !== undefined ? { text: validateRenderedText(init.text) } : {}),
    children: init.children ?? [],
    attribution: { created: { actor }, fields: {} },
  };
}

export function validateRenderedText(text: RenderedText): RenderedText {
  if (text.marks.length !== text.s.length) {
    throw new Error(`marks length ${text.marks.length} != s length ${text.s.length}`);
  }
  for (const set of text.marks) {
    const sorted = [...set].sort();
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] === sorted[i - 1]) throw new Error("marks must be unique");
    }
    for (let i = 0; i < set.length; i++) {
      if (set[i] !== sorted[i]) throw new Error("marks must be sorted");
    }
  }
  return text;
}

/** Apply a transaction to a state, immutably. Durable intent precedes state change: the transaction is logged (DM-4). */
export function applyTransaction(state: DocState, tx: Transaction): DocState {
  const next: DocState = structuredClone(state);
  tx.ops.forEach((op, index) => {
    try {
      applyOp(next, op, tx);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`transaction ${tx.id} op ${index} (${op.op}) failed: ${message}`);
    }
  });
  next.log.push(structuredClone(tx));
  return next;
}

function requireBlock(state: DocState, id: BlockId): Block {
  const block = state.blocks[id];
  if (!block) throw new Error(`no such block ${id}`);
  return block;
}

function requireAlive(state: DocState, id: BlockId): Block {
  requireBlock(state, id);
  if (!liveTree(state).alive.has(id)) throw new Error(`block ${id} is tombstoned`);
  return state.blocks[id]!;
}

function attach(state: DocState, id: BlockId, parent: BlockId | null, index: number | undefined): void {
  // Placement-register semantics (DM-4.6/4.7): a block lives in exactly one
  // list. Scrub every occurrence — including stale entries in tombstoned
  // parents' lists — so a block revived elsewhere never appears twice.
  detachFromAllLists(state, id);
  const list = parent === null ? state.roots : requireAlive(state, parent).children;
  const at = index ?? list.length;
  if (!Number.isInteger(at) || at < 0 || at > list.length) throw new Error(`index ${at} out of range`);
  list.splice(at, 0, id);
}

function detach(state: DocState, id: BlockId): void {
  const { parentOf } = liveTree(state);
  const parent = parentOf.get(id);
  if (parent === undefined) throw new Error(`block ${id} is not live`);
  const list = parent === null ? state.roots : state.blocks[parent]!.children;
  const at = list.indexOf(id);
  if (at < 0) throw new Error(`block ${id} missing from its parent's children`);
  list.splice(at, 1);
}

/** Remove every occurrence of id from roots and all children lists (register semantics). */
function detachFromAllLists(state: DocState, id: BlockId): void {
  const scratch = state.roots.indexOf(id);
  if (scratch >= 0) state.roots.splice(scratch, 1);
  for (const block of Object.values(state.blocks)) {
    const at = block.children.indexOf(id);
    if (at >= 0) block.children.splice(at, 1);
  }
}

function applyOp(state: DocState, op: Op, tx: Transaction): void {
  const writer = { actor: tx.actor.actorId, lamport: tx.lamport };
  switch (op.op) {
    case "insert": {
      if (state.blocks[op.block.id]) throw new Error(`block ${op.block.id} already exists`);
      for (const child of op.block.children) requireBlock(state, child);
      const block = structuredClone(op.block);
      // Never assign undefined: it would create an own `text` property on
      // text-less blocks and break canonical full-state comparison.
      if (block.text !== undefined) block.text = validateRenderedText(block.text);
      state.blocks[block.id] = block;
      try {
        attach(state, block.id, op.parent, op.index);
      } catch (cause) {
        delete state.blocks[block.id];
        throw cause;
      }
      return;
    }
    case "setField": {
      const block = requireBlock(state, op.block);
      block.fields[op.key] = structuredClone(op.value);
      block.attribution.fields[op.key] = writer;
      return;
    }
    case "textEdit": {
      const block = requireBlock(state, op.block);
      block.text = validateRenderedText(structuredClone(op.replace));
      block.attribution.text = writer;
      return;
    }
    case "move": {
      requireAlive(state, op.block);
      if (op.newParent === op.block) throw new Error("cannot move a block under itself");
      if (op.newParent !== null) {
        requireAlive(state, op.newParent);
        if (subtreeOf(state, op.block).has(op.newParent)) {
          throw new Error("cannot move a block into its own subtree (DM-3.1)");
        }
      }
      detach(state, op.block);
      try {
        attach(state, op.block, op.newParent, op.index);
      } catch (cause) {
        // Restore the previous position so the failed op leaves no partial state
        // visible to later ops in the same transaction; the whole transaction
        // is discarded by the caller anyway.
        throw cause;
      }
      return;
    }
    case "delete": {
      requireAlive(state, op.block);
      detach(state, op.block); // Tombstone: map entry, fields, and text persist (DM-3.4).
      return;
    }
    case "restore": {
      requireBlock(state, op.block);
      if (liveTree(state).alive.has(op.block)) throw new Error(`block ${op.block} is not tombstoned`);
      if (op.parent !== null) {
        requireAlive(state, op.parent);
        // The subtree may contain tombstoned descendants, so this check is
        // needed even though the restored block is unreachable (DM-4.6).
        if (subtreeOf(state, op.block).has(op.parent)) {
          throw new Error("cannot restore a block into its own subtree (DM-3.1)");
        }
      }
      attach(state, op.block, op.parent, op.index);
      return;
    }
  }
}
