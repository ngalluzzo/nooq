import { canonicalJson, liveTree, type DocState, type Op, type Transaction } from "@nooq/core";

/** Undo the moves, then retire only layout shells that are still empty. */
export function columnPlacementInverse(state: DocState, original: Transaction, inverse: readonly Op[], shared: boolean): Op[] {
  const { parentOf } = liveTree(state);
  const inserted = new Set<string>();
  const moved = new Map<string, string | null>();
  const widths = new Map<string, unknown>();
  for (const op of original.ops) {
    if (op.op === "insert") inserted.add(op.block.id);
    if (op.op === "move") moved.set(op.block, op.newParent);
    if (op.op === "setField" && op.key === "widths") widths.set(op.block, op.value);
  }

  const counts = new Map<string | null, number>([[null, state.roots.length]]);
  const count = (id: string | null) => counts.get(id) ?? (id === null ? state.roots.length : state.blocks[id]!.children.length);
  const safe: Op[] = [];
  const fields: Op[] = [];
  for (const op of inverse) {
    if (op.op === "move") {
      const parent = parentOf.get(op.block);
      if (parent === undefined || parent !== moved.get(op.block)
        || (op.newParent !== null && !parentOf.has(op.newParent))) continue;
      let ancestor = op.newParent;
      while (ancestor !== null && ancestor !== op.block) ancestor = parentOf.get(ancestor) ?? null;
      if (ancestor === op.block) continue;
      counts.set(parent, count(parent) - 1);
      safe.push({ ...op, index: Math.min(op.index ?? count(op.newParent), count(op.newParent)) });
      counts.set(op.newParent, count(op.newParent) + 1);
      parentOf.set(op.block, op.newParent);
    } else if ((op.op === "delete" || (op.op === "setField" && op.key === "collapseWhenEmpty" && op.value === true)) && inserted.has(op.block)) {
      const parent = parentOf.get(op.block);
      if (parent === undefined || count(op.block) > 0) continue;
      counts.set(parent, count(parent) - 1);
      parentOf.delete(op.block);
      // In shared docs an offline insert can still be in flight. Keep the
      // parent live so the arriving block can make the column visible again.
      safe.push(shared ? { op: "setField", block: op.block, key: "collapseWhenEmpty", value: true } : op);
    } else if (op.op === "setField" && op.key === "widths") {
      fields.push(op);
    }
  }

  // Keep the current sizing if a peer changed it or if their content kept
  // an inserted lane alive. The counter-inverse is built from this edit.
  for (const op of fields) {
    if (op.op !== "setField" || !parentOf.has(op.block)
      || [...inserted].some(id => parentOf.get(id) === op.block)) continue;
    if (canonicalJson(state.blocks[op.block]!.fields.widths ?? null) === canonicalJson(widths.get(op.block) ?? null)) safe.push(op);
  }
  return safe;
}
