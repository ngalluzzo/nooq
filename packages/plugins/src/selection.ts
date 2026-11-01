import type { DocState } from "@nooq/core";
import type { Immutable } from "./definitions.ts";

/** Logical positions are block identities plus UTF-16 offsets, never DOM nodes. */
export interface TextPoint { readonly block: string; readonly offset: number }
export interface DocumentTextSelection { readonly anchor: TextPoint; readonly head: TextPoint }
export interface TextRangeSegment { readonly block: string; readonly from: number; readonly to: number }

/** Live text in document preorder. Container chrome and historical blocks are excluded. */
export function textBlockOrder(snapshot: Immutable<DocState>): string[] {
  const seen = new Set<string>(), order: string[] = [];
  const walk = (ids: readonly string[]) => { for (const id of ids) {
    const block = snapshot.blocks[id]; if (!block || seen.has(id)) continue;
    seen.add(id); if (block.text) order.push(id); walk(block.children);
  } };
  walk(snapshot.roots); return order;
}

/** Resolve a directional range against one snapshot; invalid/stale endpoints fail closed. */
export function resolveTextRange(snapshot: Immutable<DocState>, selection: DocumentTextSelection): TextRangeSegment[] | undefined {
  if (!selection?.anchor || !selection.head) return;
  const order = textBlockOrder(snapshot), a = order.indexOf(selection.anchor.block), h = order.indexOf(selection.head.block);
  if (a < 0 || h < 0) return;
  for (const point of [selection.anchor, selection.head]) {
    if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > snapshot.blocks[point.block]!.text!.s.length) return;
  }
  const forward = a < h || (a === h && selection.anchor.offset <= selection.head.offset);
  const [start, end] = forward ? [selection.anchor, selection.head] : [selection.head, selection.anchor];
  return order.slice(Math.min(a, h), Math.max(a, h) + 1).map(block => ({ block,
    from: block === start.block ? start.offset : 0,
    to: block === end.block ? end.offset : snapshot.blocks[block]!.text!.s.length,
  }));
}
