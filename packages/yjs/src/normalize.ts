/**
 * normalize — physically reconcile roots/children arrays with the
 * placement register: remove strays and tombstoned entries, append
 * missing ones. Idempotent; running concurrently on different peers is
 * safe (identical deletions commute; appends converge by Yjs array
 * semantics). Projection correctness never depends on normalize() having
 * run — it is hygiene, not authority.
 */

import type * as Y from "yjs";
import type { BlockId } from "@nooq/core";
import { layout } from "./layout.ts";

export function normalize(doc: Y.Doc): void {
  const { blocks: yblocks, roots, placement } = layout(doc);
  const containerOf = new Map<BlockId, BlockId | null>();
  for (const id of yblocks.keys()) {
    const entry = placement.get(id);
    if (entry && !entry.tombstoned) containerOf.set(id, entry.parent);
  }

  const reconcile = (arr: Y.Array<BlockId>, container: BlockId | null): void => {
    const current = arr.toArray();
    for (let i = current.length - 1; i >= 0; i--) {
      if (containerOf.get(current[i]!) !== container) arr.delete(i, 1);
    }
    const present = new Set(arr.toArray());
    for (const [id, owner] of containerOf) {
      if (owner === container && !present.has(id)) {
        arr.push([id]);
        present.add(id);
      }
    }
  };

  doc.transact(() => {
    reconcile(roots, null);
    for (const [id, yb] of yblocks.entries()) {
      const children = yb.get("children") as Y.Array<BlockId> | undefined;
      if (children) reconcile(children, id);
    }
  });
}
