/**
 * Live tree — reachability, tombstones, and the DM-3.1 single-parent
 * invariant. A block is alive iff it is reachable from `roots` through
 * live `children` lists; otherwise it is tombstoned (DM-3.4) — still in
 * the block map, still addressable.
 */

import type { BlockId, DocState } from "./model.ts";

export interface LiveTree {
  alive: Set<BlockId>;
  /** Parent block ID, or null for live roots. Tombstoned blocks are absent. */
  parentOf: Map<BlockId, BlockId | null>;
}

export interface LiveTreeOptions {
  /**
   * "throw" (default) validates the state and throws on a children entry
   * referencing an absent block. "skip" tolerates it (malformed/GC'd
   * documents) by ignoring the entry, so revalidation can report the
   * target as missing instead of crashing (DM-6.1 Draft 1.2).
   */
  onMissing?: "throw" | "skip";
}

export function liveTree(state: DocState, options: LiveTreeOptions = {}): LiveTree {
  const onMissing = options.onMissing ?? "throw";
  const alive = new Set<BlockId>();
  const parentOf = new Map<BlockId, BlockId | null>();
  const stack: Array<{ parent: BlockId | null; children: readonly BlockId[]; index: number }> = [
    { parent: null, children: state.roots, index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.children.length) {
      stack.pop();
      continue;
    }
    const id = frame.children[frame.index]!;
    frame.index++;
    if (alive.has(id)) {
      throw new Error(`Block ${id} reachable from multiple parents (DM-3.1 violation)`);
    }
    const block = state.blocks[id];
    if (!block) {
      if (onMissing === "throw") throw new Error(`Missing block ${id}`);
      continue;
    }
    alive.add(id);
    parentOf.set(id, frame.parent);
    stack.push({ parent: id, children: block.children, index: 0 });
  }
  return { alive, parentOf };
}

/** All block IDs in the subtree rooted at `id`, including tombstoned descendants. */
export function subtreeOf(state: DocState, id: BlockId): Set<BlockId> {
  const out = new Set<BlockId>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) throw new Error(`Cycle at ${current} (DM-3.1 violation)`);
    out.add(current);
    const block = state.blocks[current];
    if (!block) throw new Error(`Missing block ${current}`);
    for (const child of block.children) stack.push(child);
  }
  return out;
}
