/**
 * Rebase — DM-16. The ops that rebuild a document's visible state in a new
 * lineage: every live block, parent before child, with its fields and
 * rendered text, and no tombstones. Pure; the adapter applies them with
 * fresh CRDT identities.
 */

import type { Block, BlockId, DocState, Op } from "./model.ts";

export function rebaseOps(state: DocState): Op[] {
  const ops: Op[] = [];
  const walk = (ids: readonly BlockId[], parent: BlockId | null) => {
    for (const id of ids) {
      const block = state.blocks[id]!;
      const fresh: Block = {
        id: block.id,
        type: block.type,
        fields: structuredClone(block.fields),
        ...(block.text !== undefined ? { text: structuredClone(block.text) } : {}),
        children: [],
        attribution: { created: { actor: block.attribution.created.actor }, fields: {} },
      };
      ops.push({ op: "insert", block: fresh, parent });
      walk(block.children, id);
    }
  };
  walk(state.roots, null);
  return ops;
}
