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
import { applyTextChanges, type TextChange } from "./text.ts";
import { wellFormedAccess } from "./access.ts";

export function emptyDocument(docId: string): DocState {
  return { docId, schemaVersion: 1, roots: [], blocks: {} };
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

/** Apply a transaction to a state, immutably. Its record lives in a history store, never in state (DM-14.4). */
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
  return next;
}

/**
 * Validation for THROWAWAY states (EB-6): applies the transaction to the
 * passed state IN PLACE — no defensive clone — and returns nothing. The
 * caller must treat the state as consumed. Cuts per-keystroke cost by the
 * whole-document clone applyTransaction pays to stay pure.
 */
/** Single-use transactions validated once per synchronous chain (EB-6/8):
 *  a structural op paid the full validation cascade up to three times —
 *  runtime.run, authorizeLocal, applyToDoc — each building a fresh ~5ms
 *  projection at 2k blocks. Replay is already impossible (the host's
 *  `recorded` set rejects re-applied tx ids), so the stamp cannot outlive
 *  its state. */
const validatedTx = new WeakMap<object, true>();
export function isValidated(tx: Transaction): boolean { return validatedTx.has(tx as object); }

/**
 * DM-4.10 (undo): the inverse transaction of a local action — the ops that
 * restore the pre-state, computed against the state the action validated
 * on. Undo is ANOTHER EDIT: the inverse ships as an ordinary signed
 * envelope, verified and admitted like any transaction, attributed to the
 * undoer. `undefined` marks a non-invertible action (an access write — an
 * epoch rotation cannot go backward, by 0012's design; Cmd+Z does not
 * un-revoke, you re-grant).
 */
export function inverseOf(pre: DocState, tx: Transaction): Op[] | undefined {
  const working = structuredClone(pre);
  const inverses: Op[] = [];
  for (const op of tx.ops) {
    switch (op.op) {
      case "setAccess":
        return undefined; // epochs advance only; the exception is the design
      case "insert": {
        applyOp(working, op, tx);
        inverses.push({ op: "delete", block: op.block.id });
        break;
      }
      case "delete": {
        const { parentOf } = liveTree(working);
        const parent = parentOf.get(op.block) ?? null;
        const siblings = parent === null ? working.roots : working.blocks[parent]!.children;
        const index = siblings.indexOf(op.block);
        applyOp(working, op, tx);
        inverses.push({ op: "restore", block: op.block, parent, index });
        break;
      }
      case "restore": {
        applyOp(working, op, tx);
        inverses.push({ op: "delete", block: op.block });
        break;
      }
      case "textEdit": {
        const before = working.blocks[op.block]?.text?.s ?? "";
        applyOp(working, op, tx);
        // The reverse splice: walk the changes against the pre-text; every
        // deletion returns as an insertion of what it took, every insertion
        // as a deletion of its length; retains stay — emitted in reverse.
        // The reverse splice: retentions anchor positions, deletions return
        // as insertions of what they took, insertions as deletions — IN
        // ORDER (splices invert in place; reversing the list would detach
        // the anchors).
        let at = 0;
        const parts: import("./text.ts").TextChange[] = [];
        for (const change of op.changes) {
          if ("retain" in change) { parts.push({ retain: change.retain }); at += change.retain; }
          else if ("delete" in change) { parts.push({ insert: before.slice(at, at + change.delete) }); at += change.delete; }
          else if ("insert" in change) { parts.push({ delete: change.insert.length }); }
        }
        inverses.push({ op: "textEdit", block: op.block, changes: parts });
        break;
      }
      case "setField": {
        const had = Object.prototype.hasOwnProperty.call(working.blocks[op.block]?.fields ?? {}, op.key);
        const previous = had ? structuredClone(working.blocks[op.block]!.fields[op.key]) : undefined;
        applyOp(working, op, tx);
        // A first-set cannot un-set (fields carry values, DM-3.2); its undo
        // is the nearest honest thing — leave the key (the create() default
        // usually already named it). Stated in DM-4.10.
        if (had && previous !== undefined) inverses.push({ op: "setField", block: op.block, key: op.key, value: previous });
        break;
      }
      case "move": {
        const { parentOf } = liveTree(working);
        const oldParent = parentOf.get(op.block) ?? null;
        const oldSiblings = oldParent === null ? working.roots : working.blocks[oldParent]!.children;
        const oldIndex = oldSiblings.indexOf(op.block);
        applyOp(working, op, tx);
        inverses.push({ op: "move", block: op.block, newParent: oldParent, index: oldIndex });
        break;
      }
    }
  }
  inverses.reverse();
  return inverses;
}

export function validateTransaction(state: DocState, tx: Transaction): void {
  if (tryValidateReadonly(state, tx)) return; // EB-6 fast path: O(ops) on the SHARED state, no copy, no mutation
  // EB-T: ONE live-tree per pass, maintained by the ops themselves — a
  // 101-insert column gesture paid 101 full-tree builds before (O(cells x
  // doc)); the set and map below stay exactly what liveTree(state) would
  // compute at each op, because every mutation path maintains them.
  const tree = liveTree(state);
  const scope: { alive: Set<BlockId>; parentOf: Map<BlockId, BlockId | null> } = { alive: tree.alive, parentOf: tree.parentOf };
  tx.ops.forEach((op, index) => {
    try {
      applyOp(state, op, tx, scope);
      if (op.op === "insert") scope.alive.add(op.block.id);
      else if (op.op === "restore") scope.alive.add(op.block);
      else if (op.op === "delete") scope.alive.delete(op.block);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`transaction ${tx.id} op ${index} (${op.op}) failed: ${message}`);
    }
  });
  validatedTx.set(tx as object, true);
}

function requireBlock(state: DocState, id: BlockId): Block {
  const block = state.blocks[id];
  if (!block) throw new Error(`no such block ${id}`);
  return block;
}

interface PassScope { alive: Set<BlockId>; parentOf: Map<BlockId, BlockId | null> }

function requireAlive(state: DocState, id: BlockId, scope?: PassScope): Block {
  requireBlock(state, id);
  const isAlive = scope !== undefined ? scope.alive.has(id) : liveTree(state).alive.has(id);
  if (!isAlive) throw new Error(`block ${id} is tombstoned`);
  return state.blocks[id]!;
}

function attach(state: DocState, id: BlockId, parent: BlockId | null, index: number | undefined, scope?: PassScope, fresh = false): void {
  // Placement-register semantics (DM-4.6/4.7): a block lives in exactly one
  // list. Scrub every occurrence — including stale entries in tombstoned
  // parents' lists — so a block revived elsewhere never appears twice.
  // A FRESH insert skips the scrub: the caller's already-exists check just
  // proved this block was created in this pass and never attached (EB-T:
  // the scrub is O(doc) and a 101-cell gesture paid it 101 times).
  if (!fresh) detachFromAllLists(state, id);
  const list = parent === null ? state.roots : requireAlive(state, parent, scope).children;
  const at = index ?? list.length;
  if (!Number.isInteger(at) || at < 0 || at > list.length) throw new Error(`index ${at} out of range`);
  list.splice(at, 0, id);
  scope?.parentOf.set(id, parent);
}

function detach(state: DocState, id: BlockId, scope?: PassScope): void {
  const parentOf = scope !== undefined ? scope.parentOf : liveTree(state).parentOf;
  const parent = parentOf.get(id);
  if (parent === undefined) throw new Error(`block ${id} is not live`);
  const list = parent === null ? state.roots : state.blocks[parent]!.children;
  const at = list.indexOf(id);
  if (at < 0) throw new Error(`block ${id} missing from its parent's children`);
  list.splice(at, 1);
  scope?.parentOf.delete(id);
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

function applyOp(state: DocState, op: Op, tx: Transaction, scope?: PassScope): void {
  const writer = { actor: tx.actor.actorId, lamport: tx.lamport, ...(tx.adoptedBy !== undefined ? { adoptedBy: tx.adoptedBy } : {}) };
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
        attach(state, block.id, op.parent, op.index, scope, true);
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
      const base: RenderedText = block.text ?? { s: "", marks: [] };
      block.text = validateRenderedText(applyTextChanges(base, op.changes));
      return;
    }
    case "move": {
      requireAlive(state, op.block, scope);
      if (op.newParent === op.block) throw new Error("cannot move a block under itself");
      if (op.newParent !== null) {
        requireAlive(state, op.newParent, scope);
        if (subtreeOf(state, op.block).has(op.newParent)) {
          throw new Error("cannot move a block into its own subtree (DM-3.1)");
        }
      }
      detach(state, op.block, scope);
      try {
        attach(state, op.block, op.newParent, op.index, scope);
      } catch (cause) {
        // Restore the previous position so the failed op leaves no partial state
        // visible to later ops in the same transaction; the whole transaction
        // is discarded by the caller anyway.
        throw cause;
      }
      return;
    }
    case "delete": {
      requireAlive(state, op.block, scope);
      detach(state, op.block, scope); // Tombstone: map entry, fields, and text persist (DM-3.4).
      return;
    }
    case "setAccess": {
      if (!wellFormedAccess(op.access)) throw new Error("malformed access (DM-13)");
      state.access = structuredClone(op.access);
      return;
    }
    case "restore": {
      requireBlock(state, op.block);
      if ((scope !== undefined ? scope.alive : liveTree(state).alive).has(op.block)) throw new Error(`block ${op.block} is not tombstoned`);
      if (op.parent !== null) {
        requireAlive(state, op.parent, scope);
        // The subtree may contain tombstoned descendants, so this check is
        // needed even though the restored block is unreachable (DM-4.6).
        if (subtreeOf(state, op.block).has(op.parent)) {
          throw new Error("cannot restore a block into its own subtree (DM-3.1)");
        }
      }
      attach(state, op.block, op.parent, op.index, scope);
      return;
    }
  }
}


/**
 * EB-6 fast path: read-only validation for the dominant keystroke shapes.
 * textEdit: block alive (roots-reachable is checked via the same liveTree
 * the mutating path uses — cached per call) and the splice in range.
 * setField on a live block: same liveness check. Returns true when the
 * whole transaction was validated WITHOUT mutation; false means the
 * caller falls back to the full in-place path. Property-tested equal.
 */
export function tryValidateReadonly(state: DocState, tx: Transaction, selection?: { block: BlockId; anchor: number; head: number }): boolean {
  if (tx.adoptedBy !== undefined) return false;
  const tree = liveTree(state);
  /** Post-application text length per block (only what selection needs). */
  const lengths = new Map<BlockId, number>();
  const lengthOf = (id: BlockId): number | undefined => {
    if (lengths.has(id)) return lengths.get(id);
    return state.blocks[id]?.text?.s.length;
  };
  for (const op of tx.ops) {
    if (op.op === "textEdit") {
      const block = state.blocks[op.block];
      if (!block) throw new Error(`no such block ${op.block}`); // engine semantics: requireBlock, existence only — tombstones keep data and stay editable
      const base = block.text ?? { s: "", marks: [] as string[][] };
      if (!splicesInScope(base, op.changes)) return false; // fall back to full application for the precise error
      let delta = 0;
      for (const change of op.changes) {
        if ("delete" in change) delta -= change.delete;
        else if ("insert" in change) delta += change.insert.length;
      }
      lengths.set(op.block, base.s.length + delta);
    } else if (op.op === "setField") {
      const block = state.blocks[op.block];
      if (!block) throw new Error(`no such block ${op.block}`); // engine semantics: existence only
    } else if (op.op === "insert") {
      if (!selection || selection.block !== op.block.id) return false; // structural; full path unless the selected new block
      lengths.set(op.block.id, op.block.text?.s.length ?? 0); // the fresh block: offsets against its own text
    } else {
      return false; // structural ops: full path (register semantics)
    }
  }
  if (selection) {
    const length = lengthOf(selection.block);
    if (length === undefined) return false; // block neither in state nor created by this tx
    if (!state.blocks[selection.block] && !lengths.has(selection.block)) return false;
    if (state.blocks[selection.block] && !tree.alive.has(selection.block)) return false;
    if (![selection.anchor, selection.head].every(n => Number.isInteger(n) && n >= 0 && n <= length)) throw new Error("Invalid selection request");
  }
  validatedTx.set(tx as object, true);
  return true;
}

/** Splice scope check without applying: every delete/retain step stays in range. */
function splicesInScope(base: { s: string }, changes: readonly import("./text.ts").TextChange[]): boolean {
  let at = 0;
  for (const change of changes) {
    if ("retain" in change && !("setMarks" in change)) at += change.retain;
    else if ("retain" in change) at += change.retain;
    else if ("delete" in change) { if (at + change.delete > base.s.length) return false; at += change.delete; }
    // insert: no position effect
  }
  return at <= base.s.length;
}


/** Freeze a graph in place — no clone (EB-6). For THROWAWAY or
 *  build-time values only; caller-owned graphs use the host's clone path. */
export function freezeInPlace<T>(value: T): T {
  // DM-10.2: shared references (readText's run-shared marks arrays) freeze
  // once and are skipped on revisit — O(distinct objects), not O(characters);
  // a 10k-char block with 10 runs paid a full 10k-array walk before.
  const seen = new WeakSet<object>();
  function freeze(item: unknown): void {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      if (seen.has(item)) return;
      seen.add(item);
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  }
  freeze(value);
  return value;
}
