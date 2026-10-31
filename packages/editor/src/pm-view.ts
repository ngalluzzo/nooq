/**
 * The EditorView wrapper — proposal 0003, step two.
 *
 * A real DOM surface over the state-level binding: every keystroke that
 * touches TEXT flows through PM's native input handling into the surface's
 * diff (§1). Structure keys are nooq commands, not PM steps:
 *
 *  - Enter splits the block at the caret: one nooq transaction (tail moved
 *    into a new block), the caret requested into the new block for the
 *    rebuild that lands before paint (EB-6).
 *  - Backspace at offset 0 merges into the previous sibling (one
 *    transaction) or deletes an empty block; nothing happens at the very
 *    start of the document — §2's no-hidden-invisible-UI.
 */

import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keydownHandler } from "prosemirror-keymap";
import { makeBlock, replaceChanges, type Op } from "@nooq/core";
import { createPmSurface, type PmSurface } from "./pm-surface.ts";
import type { Editor } from "./controller.ts";
import type { BlockId } from "@nooq/core";

/** Placement-register lookup: where does this block live (DM-3)? */
function locationOf(editor: Editor, blockId: BlockId): { parent: BlockId | null; index: number } {
  const view = editor.view;
  const roots = view.roots.indexOf(blockId);
  if (roots >= 0) return { parent: null, index: roots };
  for (const [id, block] of Object.entries(view.blocks)) {
    const at = block.children.indexOf(blockId);
    if (at >= 0) return { parent: id as BlockId, index: at };
  }
  return { parent: null, index: -1 };
}

const TEXT_BLOCK_PM: Record<string, string> = {
  "nooq.paragraph/v1": "nooq.paragraph/v1",
  "nooq.heading/v1": "nooq.heading/v1",
  "nooq.quote/v1": "nooq.quote/v1",
};

export interface PmViewSurface {
  readonly surface: PmSurface;
  readonly view: EditorView;
  /** The DOM node PM renders into (contenteditable). */
  readonly dom: HTMLElement;
  destroy(): void;
}

export function createPmView(editor: Editor, parent: HTMLElement): PmViewSurface {
  let view: EditorView | null = null;
  const surface = createPmSurface(editor, {
    onState: (state) => view?.updateState(state),
  });
  view = new EditorView({ mount: parent }, {
    state: surface.state,
    dispatchTransaction: (tr: Transaction) => surface.dispatch(tr),
    // Typed text replacing a cross-block selection never reaches the text
    // diff (it would be structural on the PM side); intercept before PM
    // mutates and route through nooq (§1). Single-block replacements flow
    // natively into the per-block splice diff.
    handleTextInput: (_view: EditorView, _from: number, _to: number, text: string): boolean => {
      return deleteRange(editor, surface, text);
    },
    handleKeyDown: keydownHandler({
      Enter: () => splitAtCaret(editor, surface),
      Backspace: () => deleteRange(editor, surface) || mergeAtStart(editor, surface),
      Delete: () => deleteRange(editor, surface),
      "Mod-b": () => toggleMark(editor, surface, "strong"),
      "Mod-i": () => toggleMark(editor, surface, "em"),
    }),
  });
  view.focus();
  return {
    surface,
    get view() {
      return view!;
    },
    get dom() {
      return view!.dom;
    },
    destroy() {
      view?.destroy();
      view = null;
      surface.destroy();
    },
  };
}

/** Enter: one transaction — tail to a new sibling of the same type. */
function splitAtCaret(editor: Editor, surface: PmSurface): boolean {
  const anchor = surface.selectionAnchor();
  if (!anchor) return false;
  const block = editor.view.blocks[anchor.block];
  if (!block || !(block.type in TEXT_BLOCK_PM)) return false;

  const text = block.text?.s ?? "";
  const allMarks = block.text?.marks ?? text.split("").map(() => [] as string[]);
  const tail = text.slice(anchor.offset);
  const head = text.slice(0, anchor.offset);
  const fresh = makeBlock(
    { type: block.type, ...(tail ? { text: { s: tail, marks: allMarks.slice(anchor.offset) } } : {}) },
    surface.editor.actorId,
  );
  const ops: Op[] = [];
  if (tail.length > 0) {
    ops.push({ op: "textEdit", block: anchor.block, changes: head ? [{ retain: head.length }, { delete: tail.length }] : [{ delete: tail.length }] });
  }
  const spot = locationOf(editor, anchor.block);
  ops.push({ op: "insert", block: fresh, parent: spot.parent, ...(spot.index >= 0 ? { index: spot.index + 1 } : {}) });

  surface.requestCaret({ block: fresh.id, offset: 0 });
  editor.applyOps(ops, `split:${block.type}`);
  return true;
}

/** All block ids in document order (register walk, DM-3). */
function documentOrder(editor: Editor): import("@nooq/core").BlockId[] {
  const view = editor.view;
  const out: import("@nooq/core").BlockId[] = [];
  const walk = (ids: readonly import("@nooq/core").BlockId[]): void => {
    for (const id of ids) {
      const block = view.blocks[id];
      if (!block) continue;
      out.push(id);
      walk(block.children);
    }
  };
  walk(view.roots);
  return out;
}

/**
 * Delete a cross-block selection and JOIN the edges — ONE nooq transaction
 * (§1): head is trimmed, middle blocks deleted, tail's remainder is appended
 * to the head (mark runs preserved), tail deleted. `insert` (typed
 * replacement text) rides the same transaction, inheriting the marks at the
 * caret — what writers expect when typing over a selection inside bold text.
 */
function deleteRange(editor: Editor, surface: PmSurface, insert?: string): boolean {
  const range = surface.selectionRange();
  if (!range) return false;
  const { head, tail } = range;
  const headBlock = editor.view.blocks[head.block];
  const tailBlock = editor.view.blocks[tail.block];
  if (!headBlock?.text || !tailBlock?.text) return false;

  const order = documentOrder(editor);
  const headAt = order.indexOf(head.block);
  const tailAt = order.indexOf(tail.block);
  if (headAt < 0 || tailAt < 0 || tailAt < headAt) return false;
  const middles = order.slice(headAt + 1, tailAt);

  const headText = headBlock.text.s;
  const headMarks = headBlock.text.marks;
  const tailText = tailBlock.text.s;
  const tailMarks = tailBlock.text.marks;
  const inherit = insert !== undefined ? (headMarks[head.offset - 1] ?? []) : [];

  const changes: import("@nooq/core").TextChange[] = [];
  if (head.offset > 0) changes.push({ retain: head.offset });
  if (headText.length - head.offset > 0) changes.push({ delete: headText.length - head.offset });
  if (insert !== undefined && insert.length > 0) {
    changes.push(inherit.length > 0 ? { insert, marks: inherit } : { insert });
  }
  // Tail remainder appended as mark runs.
  let buf = "";
  let bufMarks: string[] | null = null;
  const flush = () => {
    if (buf.length === 0) return;
    changes.push(bufMarks && bufMarks.length > 0 ? { insert: buf, marks: bufMarks } : { insert: buf });
    buf = "";
    bufMarks = null;
  };
  for (let i = tail.offset; i < tailText.length; i++) {
    const marks = tailMarks[i] ?? [];
    if (bufMarks === null || (bufMarks.length === marks.length && bufMarks.every((m, k) => m === marks[k]))) {
      buf += tailText[i]!;
      bufMarks = marks;
    } else {
      flush();
      buf = tailText[i]!;
      bufMarks = marks;
    }
  }
  flush();

  const ops: Op[] = [];
  if (changes.length > 0) ops.push({ op: "textEdit", block: head.block, changes });
  ops.push({ op: "delete", block: tail.block });
  for (const middle of middles) ops.push({ op: "delete", block: middle });

  surface.requestCaret({ block: head.block, offset: head.offset + (insert?.length ?? 0) });
  editor.applyOps(ops, insert !== undefined ? "replace-range" : "delete-range");
  return true;
}

/** Ctrl-B / Ctrl-I: toggle a mark over the selection — a PM step, diffed into setMarks (§1). */
function toggleMark(editor: Editor, surface: PmSurface, name: "strong" | "em"): boolean {
  void editor;
  const state = surface.state;
  const markType = state.schema.marks[name];
  if (!markType || state.selection.empty) return false;
  const { from, to } = state.selection;
  const covered = state.doc.rangeHasMark(from, to, markType);
  surface.dispatch(covered ? state.tr.removeMark(from, to, markType) : state.tr.addMark(from, to, markType.create()));
  return true;
}

/** Backspace at offset 0: merge into the previous sibling, or drop an empty block. */
function mergeAtStart(editor: Editor, surface: PmSurface): boolean {
  const anchor = surface.selectionAnchor();
  if (!anchor || anchor.offset !== 0) return false;
  const block = editor.view.blocks[anchor.block];
  if (!block) return false;

  const spot = locationOf(editor, anchor.block);
  if (spot.index <= 0) return false; // first block: nothing before it (§2)
  const siblings = spot.parent ? editor.view.blocks[spot.parent]?.children : editor.view.roots;
  const previous = siblings?.[spot.index - 1];
  const previousBlock = previous !== undefined ? editor.view.blocks[previous] : undefined;
  if (!previous || !previousBlock) return false;
  if (!previousBlock) return false;
  if (previousBlock.type !== block.type || !(block.type in TEXT_BLOCK_PM)) {
    // Structural adjacency (sections etc.) stays explicit: no merge.
    return false;
  }

  const previousLen = previousBlock.text?.s.length ?? 0;
  const text = block.text?.s ?? "";
  const textMarks = block.text?.marks ?? text.split("").map(() => [] as string[]);
  const ops: Op[] = [];
  if (text.length > 0) {
    // Insert runs grouped by marks — merged bold text stays bold (DM-3.3).
    const changes: import("@nooq/core").TextChange[] = [];
    if (previousLen > 0) changes.push({ retain: previousLen });
    let buf = "";
    let bufMarks: string[] | null = null;
    for (let i = 0; i < text.length; i++) {
      const marks = textMarks[i] ?? [];
      if (bufMarks === null || marks.length === bufMarks.length && marks.every((m, k) => m === bufMarks![k])) {
        buf += text[i]!;
        bufMarks = marks;
      } else {
        changes.push(bufMarks && bufMarks.length > 0 ? { insert: buf, marks: bufMarks } : { insert: buf });
        buf = text[i]!;
        bufMarks = marks;
      }
    }
    if (buf.length > 0) changes.push(bufMarks && bufMarks.length > 0 ? { insert: buf, marks: bufMarks } : { insert: buf });
    ops.push({ op: "textEdit", block: previous, changes });
  }
  ops.push({ op: "delete", block: anchor.block });
  surface.requestCaret({ block: previous, offset: previousLen });
  editor.applyOps(ops, "merge");
  return true;
}
