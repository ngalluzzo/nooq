import * as Y from "yjs";
import { canonicalJson, liveTree, type DocState, type Op, type TextChange } from "@nooq/core";
import { layout } from "@nooq/yjs";

type Insert = Extract<TextChange, { insert: string }>;
type TextOp = Extract<Op, { op: "textEdit" }>;
type ClockSpan = { from: number; to: number };
type Insertion = { at: Y.RelativePosition; changes: Insert[] };
type AnchoredText = { removed: Map<number, ClockSpan[]>; restored: Insertion[] };
export interface PasteUndo {
  text: Map<number, AnchoredText>;
  blocks: Map<string, string>;
  siblings: Map<string | null, readonly string[]>;
}

const textOf = (doc: Y.Doc, id: string) => layout(doc).blocks.get(id)?.get("text") as Y.Text | undefined;

function* items(text: Y.Text) {
  let offset = 0;
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    yield { client: item.id.client, clock: item.id.clock, length: item.length, offset };
    offset += item.length;
  }
}

/** Local undo metadata only. The inverse still travels as ordinary nooq ops. */
export function anchorPasteUndo(doc: Y.Doc, before: DocState, after: DocState, inverse: readonly Op[]): PasteUndo {
  const result: PasteUndo = { text: new Map(), blocks: new Map(), siblings: new Map() };
  inverse.forEach((op, index) => {
    if (op.op === "delete") {
      result.blocks.set(op.block, canonicalJson([after.blocks[op.block], layout(doc).placement.get(op.block) ?? null]));
      return;
    }
    if (op.op === "restore") {
      result.siblings.set(op.parent, op.parent === null ? before.roots : before.blocks[op.parent]!.children);
      return;
    }
    if (op.op !== "textEdit") return;
    const text = textOf(doc, op.block);
    if (!text) return;
    const removed = new Map<number, ClockSpan[]>();
    const restored: Insertion[] = [];
    const deletions: ClockSpan[] = [];
    let offset = 0;
    for (let i = 0; i < op.changes.length; i++) {
      const change = op.changes[i]!;
      if ("retain" in change) { offset += change.retain; continue; }
      if ("delete" in change) {
        deletions.push({ from: offset, to: offset + change.delete });
        offset += change.delete;
        continue;
      }
      const changes = [change];
      for (; i + 1 < op.changes.length; i++) {
        const next = op.changes[i + 1]!;
        if (!("insert" in next)) break;
        changes.push(next);
      }
      const next = op.changes[i + 1];
      // Associate a replacement with its pasted text, so a peer insertion
      // immediately before it remains before the restored selection.
      const assoc = next && "delete" in next ? 0 : -1;
      restored.push({ at: Y.createRelativePositionFromTypeIndex(text, offset, assoc), changes });
    }
    let first = 0;
    for (const item of items(text)) {
      const end = item.offset + item.length;
      while (first < deletions.length && deletions[first]!.to <= item.offset) first++;
      for (let i = first; i < deletions.length && deletions[i]!.from < end; i++) {
        const run = deletions[i]!;
        const from = item.clock + Math.max(0, run.from - item.offset);
        const to = item.clock + Math.min(item.length, run.to - item.offset);
        if (from >= to) continue;
        const spans = removed.get(item.client) ?? [];
        spans.push({ from, to });
        removed.set(item.client, spans);
      }
    }
    for (const spans of removed.values()) spans.sort((a, b) => a.from - b.from);
    result.text.set(index, { removed, restored });
  });
  return result;
}

function rebaseText(doc: Y.Doc, op: TextOp, anchors: AnchoredText): TextChange[] | undefined {
  const text = textOf(doc, op.block);
  if (!text) return;
  const events = new Map<number, { delta: number; inserts: Insert[] }>();
  const at = (offset: number) => {
    let event = events.get(offset);
    if (!event) { event = { delta: 0, inserts: [] }; events.set(offset, event); }
    return event;
  };
  for (const { at: anchor, changes } of anchors.restored) {
    const point = Y.createAbsolutePositionFromRelativePosition(anchor, doc);
    if (point?.type !== text) return;
    at(point.index).inserts.push(...changes);
  }
  for (const item of items(text)) {
    const spans = anchors.removed.get(item.client);
    if (!spans) continue;
    let low = 0, high = spans.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (spans[mid]!.to <= item.clock) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < spans.length && spans[i]!.from < item.clock + item.length; i++) {
      const span = spans[i]!;
      at(item.offset + Math.max(0, span.from - item.clock)).delta++;
      at(item.offset + Math.min(item.length, span.to - item.clock)).delta--;
    }
  }
  const changes: TextChange[] = [];
  let offset = 0, deleting = 0;
  for (const [position, event] of [...events].sort(([a], [b]) => a - b)) {
    if (position > offset) changes.push(deleting ? { delete: position - offset } : { retain: position - offset });
    changes.push(...event.inserts);
    offset = position;
    deleting += event.delta;
  }
  return changes;
}

export function rebasePasteUndo(doc: Y.Doc, state: DocState, inverse: readonly Op[], anchors: PasteUndo): Op[] | undefined {
  const { alive, parentOf } = liveTree(state);
  for (const [id, before] of anchors.blocks) {
    if (!alive.has(id) || canonicalJson([state.blocks[id], layout(doc).placement.get(id) ?? null]) !== before) return;
  }
  const ops: Op[] = [];
  const siblingLists = new Map<string | null, string[]>();
  const replacedAt = new Map<string | null, number>();
  const siblingsOf = (parent: string | null) => {
    let siblings = siblingLists.get(parent);
    if (!siblings) {
      siblings = [...(parent === null ? state.roots : state.blocks[parent]!.children)];
      siblingLists.set(parent, siblings);
    }
    return siblings;
  };
  for (const [index, op] of inverse.entries()) {
    if (op.op === "delete") {
      const parent = parentOf.get(op.block)!;
      const siblings = siblingsOf(parent);
      const at = siblings.indexOf(op.block);
      siblings.splice(at, 1);
      replacedAt.set(parent, Math.min(replacedAt.get(parent) ?? at, at));
      alive.delete(op.block);
    }
    if (op.op === "restore") {
      if (alive.has(op.block) || (op.parent !== null && !alive.has(op.parent))) return;
      const original = anchors.siblings.get(op.parent)!;
      const slot = original.indexOf(op.block);
      const siblings = siblingsOf(op.parent);
      // Keep peer insertions on either side of the replacement. Surviving
      // neighbors constrain the slot and keep multiple restored blocks ordered.
      const right = original.slice(slot + 1).find(id => siblings.includes(id));
      const left = original.slice(0, slot).reverse().find(id => siblings.includes(id));
      const lower = left ? siblings.indexOf(left) + 1 : 0;
      const upper = right ? siblings.indexOf(right) : siblings.length;
      const preferred = replacedAt.get(op.parent) ?? (right ? upper : left ? lower : op.index ?? upper);
      const at = Math.min(upper, Math.max(lower, preferred));
      siblings.splice(at, 0, op.block);
      alive.add(op.block);
      ops.push({ ...op, index: at });
      continue;
    }
    if (op.op !== "textEdit") { ops.push(op); continue; }
    const text = anchors.text.get(index);
    if (!text || !alive.has(op.block)) return;
    const changes = rebaseText(doc, op, text);
    if (!changes) return;
    if (changes.length) ops.push({ ...op, changes });
  }
  return ops;
}
