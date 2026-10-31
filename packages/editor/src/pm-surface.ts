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
    doc: { content: "block+", toDOM: () => ["div", { class: "nooq-doc" }, 0] },
    section: {
      content: "block+",
      attrs: { [BLOCK_ID]: { default: "" } },
      group: "block",
      toDOM: () => ["div", { class: "nooq-section" }, 0],
    },
    paragraph: {
      content: "inline*",
      attrs: { [BLOCK_ID]: { default: "" } },
      group: "block",
      toDOM: () => ["p", 0],
    },
    heading: {
      content: "inline*",
      attrs: { [BLOCK_ID]: { default: "" } },
      group: "block",
      toDOM: () => ["h2", 0],
    },
    quote: {
      content: "inline*",
      attrs: { [BLOCK_ID]: { default: "" } },
      group: "block",
      toDOM: () => ["blockquote", 0],
    },
    text: { group: "inline" },
  },
  // DM-3.3: per-character attributes. nooq mark names are PM mark names —
  // identity mapping, register-equal (no translation table to drift).
  marks: {
    strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }] },
    em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }] },
  },
});

interface PmBlock {
  id: BlockId;
  type: string; // pm node type
  text: string;
  /** Per-character mark names, parallel to text (DM-3.3). */
  charMarks: string[][];
  children: PmBlock[];
}

/** Projection → PM doc JSON, depth-first (the tree stays a tree: §4). */
function projectionToBlocks(view: DocState): PmBlock[] {
  const walk = (ids: readonly BlockId[]): PmBlock[] =>
    ids.flatMap((id) => {
      const block = view.blocks[id];
      if (!block) return [];
      if (block.type === "nooq.section/v1") {
        return [{ id, type: "section", text: "", charMarks: [] as string[][], children: walk(block.children) }];
      }
      const pmType = TEXT_TYPES[block.type];
      if (!pmType) return []; // non-text blocks are node views, never text (0003)
      const text = block.text?.s ?? "";
      const charMarks: string[][] = block.text?.marks ?? text.split("").map(() => [] as string[]);
      return [{ id, type: pmType, text, charMarks, children: [] as PmBlock[] }];
    });
  return walk(view.roots);
}

export function pmDocFromProjection(view: DocState): Node {
  const runs = (block: PmBlock): Array<{ text: string; marks: string[] }> => {
    const out: Array<{ text: string; marks: string[] }> = [];
    for (let i = 0; i < block.text.length; i++) {
      const marks = block.charMarks[i] ?? [];
      const last = out.at(-1);
      if (last && sameMarks(last.marks, marks)) last.text += block.text[i];
      else out.push({ text: block.text[i]!, marks });
    }
    return out;
  };
  const toContent = (blocks: PmBlock[]): unknown[] =>
    blocks.map((block) => ({
      type: block.type,
      attrs: { [BLOCK_ID]: block.id },
      ...(block.children.length > 0 || block.type === "section"
        ? { content: toContent(block.children) }
        : {
            content: runs(block).map((run) => ({
              type: "text",
              text: run.text,
              ...(run.marks.length > 0 ? { marks: run.marks.map((type) => ({ type })) } : {}),
            })),
          }),
    }));
  return Node.fromJSON(pmSchema, { type: "doc", content: toContent(projectionToBlocks(view)) });
}

function sameMarks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((mark, i) => mark === b[i]);
}

function sameCharMarks(a: { charMarks: string[][] }, b: { charMarks: string[][] }): boolean {
  return a.charMarks.length === b.charMarks.length && a.charMarks.every((marks, i) => sameMarks(marks, b.charMarks[i] ?? []));
}

/**
 * Character diff over (char, marks) pairs: common full-identity prefix and
 * suffix, then the middle. A text-identical middle emits setMarks runs over
 * changed spans (a bare Ctrl-B); anything else is delete + insert-with-marks
 * runs. Plain typing degrades to exactly the prefix/suffix splice shape.
 */
export function charDiff(a: { text: string; charMarks: string[][] }, b: { text: string; charMarks: string[][] }): TextChange[] {
  const oldChars = [...a.text];
  const newChars = [...b.text];
  const eq = (i: number, j: number): boolean =>
    oldChars[i] === newChars[j] && sameMarks(a.charMarks[i] ?? [], b.charMarks[j] ?? []);

  let prefix = 0;
  while (prefix < oldChars.length && prefix < newChars.length && eq(prefix, prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < oldChars.length - prefix &&
    suffix < newChars.length - prefix &&
    eq(oldChars.length - 1 - suffix, newChars.length - 1 - suffix)
  ) suffix++;

  const oldMid = oldChars.slice(prefix, oldChars.length - suffix);
  const newMid = newChars.slice(prefix, newChars.length - suffix);
  const changes: TextChange[] = [];
  if (prefix > 0) changes.push({ retain: prefix });

  const oldMidText = oldMid.join("");
  const newMidText = newMid.join("");
  if (oldMidText === newMidText) {
    // Marks-only change: {retain: gap} then {retain: len, setMarks} per
    // changed span — core's setMarks applies at the CUMULATIVE cursor, so
    // every span is preceded by a retain for the gap since the last one.
    const spans: Array<{ start: number; len: number; marks: string[] }> = [];
    let open: { start: number; len: number; marks: string[] } | null = null;
    for (let i = 0; i < newMid.length; i++) {
      const marks = b.charMarks[prefix + i] ?? [];
      const changed = !sameMarks(marks, a.charMarks[prefix + i] ?? []);
      if (changed && open && sameMarks(open.marks, marks)) {
        open.len++;
      } else {
        if (open) spans.push(open);
        open = changed ? { start: i, len: 1, marks } : null;
      }
    }
    if (open) spans.push(open);

    let covered = 0; // middle chars already emitted
    for (const span of spans) {
      const gap = span.start - covered;
      if (gap > 0) changes.push({ retain: gap });
      changes.push({ retain: span.len, setMarks: span.marks });
      covered = span.start + span.len;
    }
    return changes;
  }

  if (oldMidText.length > 0) changes.push({ delete: oldMidText.length });
  // Insert runs grouped by marks.
  let buf = "";
  let bufMarks: string[] | null = null;
  const flushInsert = () => {
    if (buf.length === 0) return;
    changes.push(bufMarks && bufMarks.length > 0 ? { insert: buf, marks: bufMarks } : { insert: buf });
    buf = "";
    bufMarks = null;
  };
  for (let i = 0; i < newMid.length; i++) {
    const marks = b.charMarks[prefix + i] ?? [];
    if (bufMarks === null || sameMarks(bufMarks, marks)) {
      buf += newMid[i]!;
      bufMarks = marks;
    } else {
      flushInsert();
      buf = newMid[i]!;
      bufMarks = marks;
    }
  }
  flushInsert();
  return changes;
}

export interface PmTextBlock {
  id: BlockId;
  start: number;
  end: number;
  text: string;
  /** Per-character mark names, parallel to text (DM-3.3). */
  charMarks: string[][];
}

/** Textblocks in document order — the diff unit of the binding. */
function flattenTextBlocks(node: Node, out: PmTextBlock[]): void {
  node.descendants((child, pos) => {
    if (child.isTextblock) {
      const id = child.attrs[BLOCK_ID] as BlockId | undefined;
      if (id !== undefined) {
        const text = child.textContent;
        const charMarks: string[][] = [];
        child.forEach((inline) => {
          if (inline.isText && inline.text) {
            const names = inline.marks.map((mark) => mark.type.name);
            for (const _ of inline.text) charMarks.push([...names]);
          }
        });
        void text;
        out.push({ id, start: pos + 1, end: pos + 1 + child.content.size, text, charMarks });
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
  /** One-shot caret for the next projection rebuild (structure commands). */
  requestCaret(anchor: { block: BlockId; offset: number } | null): void;
  destroy(): void;
}

export interface SurfaceOptions {
  /** Called after every state change — the EditorView wrapper mounts on it. */
  onState?: (state: EditorState) => void;
}

export function createPmSurface(editor: Editor, options: SurfaceOptions = {}): PmSurface {
  let state = EditorState.create({ doc: pmDocFromProjection(editor.view), schema: pmSchema });
  let lastProjection = editor.view;
  let requestedCaret: { block: BlockId; offset: number } | null = null;
  const commit = (next: EditorState): void => {
    state = next;
    options.onState?.(state);
  };

  const unsubscribe = editor.onChange(() => {
    const next = editor.view;
    // Structure changed: re-derive the whole projection (v1 strategy).
    if (structureSignature(lastProjection) !== structureSignature(next)) {
      commit(safeReplace(state, next));
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
      if (before[i]!.text === after[i]!.text && sameCharMarks(before[i]!, after[i]!)) continue;
      const info = textblockAt(tr.doc, before[i]!.id);
      if (!info) continue;
      const changes = charDiff(before[i]!, after[i]!);
      let cursor = 0; // offset within the ORIGINAL block text
      let delta = 0; // cumulative shift applied by earlier splices
      for (const change of changes) {
        if ("setMarks" in change) {
          const from = info.start + cursor + delta;
          const to = from + change.retain;
          const target = change.setMarks ?? [];
          for (const markType of Object.values(pmSchema.marks)) {
            tr = tr.removeMark(from, to, markType);
          }
          for (const name of target) {
            const markType = pmSchema.marks[name];
            if (markType) tr = tr.addMark(from, to, markType.create());
          }
          cursor += change.retain;
        } else if ("insert" in change) {
          const at = info.start + cursor + delta;
          tr = tr.insertText(change.insert, at);
          const marks = change.marks ?? [];
          if (marks.length > 0) {
            for (const name of marks) {
              const markType = pmSchema.marks[name];
              if (markType) tr = tr.addMark(at, at + change.insert.length, markType.create());
            }
          }
          delta += change.insert.length;
        } else if ("delete" in change) {
          tr = tr.delete(info.start + cursor + delta, info.start + cursor + delta + change.delete);
          cursor += change.delete;
          delta -= change.delete;
        } else if ("retain" in change) {
          cursor += change.retain;
        }
      }
      changed = true;
    }
    if (changed) {
      commit(state.apply(tr)); // selection maps through the steps (EB-7.1)
    }
    lastProjection = next;
  });

  function collect(view: DocState): Array<{ id: BlockId; text: string; charMarks: string[][] }> {
    return projectionToBlocks(view)
      .flatMap((block) => flatten(block))
      .map((block) => ({ id: block.id, text: block.text, charMarks: block.charMarks }));
  }
  function flatten(block: PmBlock): PmBlock[] {
    return block.type === "section" ? block.children.flatMap(flatten) : [block];
  }

  function safeReplace(current: EditorState, view: DocState): EditorState {
    // Rebuild, carrying selection by block+offset anchor (SW-7 shape);
    // a requested caret (structure command) takes precedence.
    const anchor = requestedCaret ?? selectionAnchorOf(current);
    requestedCaret = null;
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
      commit(next);
      // Diff textblocks old→new: identical ids, per-block DM-4.3 splices,
      // mark-aware at character granularity (DM-3.3).
      const oldFlat = textblocksOf(before);
      const newFlat = textblocksOf(next.doc);
      if (oldFlat.length !== newFlat.length) return; // structure changed on the PM side; onChange re-derives
      for (let i = 0; i < oldFlat.length; i++) {
        const a = oldFlat[i]!;
        const b = newFlat[i]!;
        if (a.id !== b.id || (a.text === b.text && sameCharMarks(a, b))) continue;
        const changes = charDiff(a, b);
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
      if (pos !== null) commit(state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos))));
    },
    /** One-shot caret for the next rebuild — structure commands use it. */
    requestCaret(anchor: { block: BlockId; offset: number } | null): void {
      requestedCaret = anchor;
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
export function textblocksOf(doc: Node): PmTextBlock[] {
  const out: PmTextBlock[] = [];
  flattenTextBlocks(doc, out);
  return out;
}
