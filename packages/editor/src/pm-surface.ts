/**
 * The ProseMirror surface — proposal 0003's spike.
 *
 * PM here is exactly what DM-9 says: a PROJECTION, never the authority.
 * Every local keystroke diffs the PM doc's textblocks and enters the
 * document as DM-4.3 splices through Editor.apply (§1). Every remote
 * admitted change patches the PM doc with transactions whose step maps
 * carry the selection — EB-7.1 at the surface by construction, the same
 * semantics as the splice math the textarea seam needed, now native.
 *
 * State-level by design: this module touches no DOM, so CI proves the
 * seam; a EditorView wrapper mounts it later.
 *
 * Diff-based, not step-translation: the PM doc is derived state, so the
 * binding compares projections rather than parsing PM steps. Our own
 * local writes therefore come back through onChange as an empty diff —
 * there is no feedback loop to guard.
 */

import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import { Node, Schema } from "prosemirror-model";
import { replaceChanges, type BlockId, type DocState, type TextChange } from "@nooq/core";
import type { Editor } from "./controller.ts";

export const BLOCK_ID = "blockId";

const TEXT_TYPES: Record<string, string> = {
  "nooq.paragraph/v1": "paragraph",
  "nooq.heading/v1": "heading",
  "nooq.quote/v1": "quote",
};

export const pmSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    section: { content: "block+", attrs: { [BLOCK_ID]: { default: "" } }, group: "block" },
    paragraph: { content: "inline*", attrs: { [BLOCK_ID]: { default: "" } }, group: "block" },
    heading: { content: "inline*", attrs: { [BLOCK_ID]: { default: "" } }, group: "block" },
    quote: { content: "inline*", attrs: { [BLOCK_ID]: { default: "" } }, group: "block" },
    text: { group: "inline" },
  },
  marks: {}, // spike scope: plain text; per-character marks (DM-3.3) follow
});

interface PmBlock {
  id: BlockId;
  type: string; // pm node type
  text: string;
  children: PmBlock[];
}

/** Projection → PM doc JSON, depth-first (the tree stays a tree: §4). */
function projectionToBlocks(view: DocState): PmBlock[] {
  const walk = (ids: readonly BlockId[]): PmBlock[] =>
    ids.flatMap((id) => {
      const block = view.blocks[id];
      if (!block) return [];
      if (block.type === "nooq.section/v1") {
        return [{ id, type: "section", text: "", children: walk(block.children) }];
      }
      const pmType = TEXT_TYPES[block.type];
      if (!pmType) return []; // non-text blocks are node views, never text (0003)
      return [{ id, type: pmType, text: block.text?.s ?? "", children: [] }];
    });
  return walk(view.roots);
}

export function pmDocFromProjection(view: DocState): Node {
  const toContent = (blocks: PmBlock[]): unknown[] =>
    blocks.map((block) => ({
      type: block.type,
      attrs: { [BLOCK_ID]: block.id },
      ...(block.children.length > 0 || block.type === "section"
        ? { content: toContent(block.children) }
        : block.text
          ? { content: [{ type: "text", text: block.text }] }
          : {}),
    }));
  return Node.fromJSON(pmSchema, { type: "doc", content: toContent(projectionToBlocks(view)) });
}

/** Textblocks in document order — the diff unit of the binding. */
function flattenTextBlocks(node: Node, out: Array<{ id: BlockId; start: number; end: number; text: string }>): void {
  node.descendants((child, pos) => {
    if (child.isTextblock) {
      const id = child.attrs[BLOCK_ID] as BlockId | undefined;
      if (id !== undefined) {
        out.push({ id, start: pos + 1, end: pos + 1 + child.content.size, text: child.textContent });
      }
    }
    return true;
  });
}

function structureSignature(view: DocState): string {
  const shape = (ids: readonly BlockId[]): unknown =>
    ids.flatMap((id) => {
      const block = view.blocks[id];
      if (!block) return [];
      return block.type === "nooq.section/v1" ? [["section", id, shape(block.children)]] : [[block.type, id]];
    });
  return JSON.stringify(shape(view.roots));
}

export interface PmSurface {
  readonly state: EditorState;
  /** Local: apply a PM transaction and route its text diffs into nooq. */
  dispatch(transaction: Transaction): void;
  /** The editor this surface projects. */
  readonly editor: Editor;
  /** Block+offset anchor (SW-7) → absolute PM position in the current doc. */
  anchorToPos(anchor: { block: BlockId; offset: number }): number | null;
  /** Current selection as a SW-7 anchor (block identity, never positions). */
  selectionAnchor(): { block: BlockId; offset: number } | null;
  /** Map a selection through this surface's transactions (EB-7.1 helper). */
  setCursor(offset: number, blockId?: BlockId): void;
  destroy(): void;
}

export function createPmSurface(editor: Editor): PmSurface {
  let state = EditorState.create({ doc: pmDocFromProjection(editor.view), schema: pmSchema });
  let lastProjection = editor.view;

  const unsubscribe = editor.onChange(() => {
    const next = editor.view;
    // Structure changed: re-derive the whole projection (v1 strategy).
    if (structureSignature(lastProjection) !== structureSignature(next)) {
      state = safeReplace(state, next);
      lastProjection = next;
      return;
    }
    // Text-only change: apply the ACTUAL splices (DM-4.3) as precise steps —
    // never whole-block replaces, which would collapse carets inside the
    // range (EB-7.1 holds by construction only at splice granularity).
    // Blocks in REVERSE document order; splices within a block in order,
    // positions compensated by the running delta.
    const before = collect(lastProjection);
    const after = collect(next);
    let tr = state.tr;
    let changed = false;
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i]!.text === after[i]!.text) continue;
      const info = textblockAt(tr.doc, before[i]!.id);
      if (!info) continue;
      const changes = replaceChanges(before[i]!.text, after[i]!.text);
      let cursor = 0; // offset within the ORIGINAL block text
      let delta = 0; // cumulative shift applied by earlier splices
      for (const change of changes) {
        if ("retain" in change) {
          cursor += change.retain;
        } else if ("insert" in change) {
          tr = tr.insertText(change.insert, info.start + cursor + delta);
          delta += change.insert.length;
        } else if ("delete" in change) {
          tr = tr.delete(info.start + cursor + delta, info.start + cursor + delta + change.delete);
          cursor += change.delete;
          delta -= change.delete;
        }
      }
      changed = true;
    }
    if (changed) {
      state = state.apply(tr); // selection maps through the steps (EB-7.1)
    }
    lastProjection = next;
  });

  function collect(view: DocState): PmBlock[] {
    return projectionToBlocks(view).flatMap((block) => flatten(block));
  }
  function flatten(block: PmBlock): PmBlock[] {
    return block.type === "section" ? block.children.flatMap(flatten) : [block];
  }

  function safeReplace(current: EditorState, view: DocState): EditorState {
    // Rebuild, carrying selection by block+offset anchor (SW-7 shape).
    const anchor = selectionAnchorOf(current);
    const next = EditorState.create({ doc: pmDocFromProjection(view), schema: pmSchema });
    if (!anchor) return next;
    const pos = anchorPos(next.doc, anchor);
    return pos === null ? next : next.apply(next.tr.setSelection(TextSelection.create(next.doc, pos)));
  }

  return {
    editor,
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      const before = state.doc;
      const next = state.apply(transaction);
      state = next;
      // Diff textblocks old→new: identical ids, per-block DM-4.3 splices.
      const oldFlat = textblocksOf(before);
      const newFlat = textblocksOf(next.doc);
      if (oldFlat.length !== newFlat.length) return; // structure changed on the PM side; onChange re-derives
      for (let i = 0; i < oldFlat.length; i++) {
        const a = oldFlat[i]!;
        const b = newFlat[i]!;
        if (a.id !== b.id || a.text === b.text) continue;
        const changes = replaceChanges(a.text, b.text);
        if (changes.length > 0) editor.applyTextChanges(a.id, changes);
      }
    },
    anchorToPos(anchor) {
      const pos = anchorPos(state.doc, anchor);
      return pos;
    },
    selectionAnchor() {
      return selectionAnchorOf(state);
    },
    setCursor(offset: number, blockId?: BlockId) {
      const id = blockId ?? firstTextblockId(state.doc);
      if (id === null) return;
      const pos = anchorPos(state.doc, { block: id, offset });
      if (pos !== null) state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    },
    destroy() {
      unsubscribe();
    },
  };
}

function textblockAt(doc: Node, id: BlockId): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null;
  doc.descendants((node, pos) => {
    if (found === null && node.isTextblock && node.attrs[BLOCK_ID] === id) {
      found = { start: pos + 1, end: pos + 1 + node.content.size };
    }
    return found === null;
  });
  return found;
}

function anchorPos(doc: Node, anchor: { block: BlockId; offset: number }): number | null {
  const info = textblockAt(doc, anchor.block);
  if (!info) return null;
  return Math.min(Math.max(info.start + anchor.offset, info.start), info.end);
}

function firstTextblockId(doc: Node): BlockId | null {
  let id: BlockId | null = null;
  doc.descendants((node) => {
    if (id === null && node.isTextblock) {
      const attr = node.attrs[BLOCK_ID] as BlockId | undefined;
      if (attr !== undefined) id = attr;
    }
    return id === null;
  });
  return id;
}

function selectionAnchorOf(state: EditorState): { block: BlockId; offset: number } | null {
  const $pos = state.selection.$from;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.isTextblock) {
      const id = node.attrs[BLOCK_ID] as BlockId | undefined;
      if (id !== undefined) return { block: id, offset: $pos.parentOffset };
    }
  }
  return null;
}

/** Exposed for tests: block text-order flattening of a PM doc. */
export function textblocksOf(doc: Node): Array<{ id: BlockId; start: number; end: number; text: string }> {
  const out: Array<{ id: BlockId; start: number; end: number; text: string }> = [];
  flattenTextBlocks(doc, out);
  return out;
}
