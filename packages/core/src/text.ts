/**
 * Text splices — DM-4.3 (Draft 1.5).
 *
 * Changes apply left to right against a block's sequence CRDT. This
 * module holds the pure forms: application over rendered text (the
 * sequential engine), a diff builder that turns whole-string edits into
 * minimal splices, and the caret math EB-7's invariant is written in.
 */

import type { RenderedText } from "./model.ts";

export type TextChange =
  | { retain: number }
  | { retain: number; setMarks: string[] | null }
  | { insert: string; marks?: string[] }
  | { delete: number };

export class TextChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextChangeError";
  }
}

function sortedUnique(marks: readonly string[]): string[] {
  return [...new Set(marks)].sort();
}

/** Apply changes to rendered text, immutably. Positions are UTF-16 code units. */
export function applyTextChanges(text: RenderedText, changes: readonly TextChange[]): RenderedText {
  let s = "";
  const marks: string[][] = [];
  let position = 0;
  for (const change of changes) {
    if ("retain" in change) {
      if (change.retain < 0 || position + change.retain > text.s.length) {
        throw new TextChangeError(`retain ${change.retain} out of range at ${position}`);
      }
      const slice = text.s.slice(position, position + change.retain);
      const sliceMarks = "setMarks" in change
        ? Array.from({ length: slice.length }, () => (change.setMarks === null ? [] : [...sortedUnique(change.setMarks)]))
        : text.marks.slice(position, position + change.retain);
      s += slice;
      marks.push(...sliceMarks);
      position += change.retain;
      continue;
    }
    if ("insert" in change) {
      const set = sortedUnique(change.marks ?? []);
      s += change.insert;
      for (let i = 0; i < change.insert.length; i++) marks.push([...set]);
      continue;
    }
    if ("delete" in change) {
      if (change.delete < 0 || position + change.delete > text.s.length) {
        throw new TextChangeError(`delete ${change.delete} out of range at ${position}`);
      }
      position += change.delete;
      continue;
    }
    throw new TextChangeError("unknown change shape");
  }
  // DM-4.3: trailing retains may be omitted — an early stop leaves the
  // remainder untouched. Only out-of-range steps are malformed.
  if (position < text.s.length) {
    s += text.s.slice(position);
    marks.push(...text.marks.slice(position));
  }
  return { s, marks };
}

/**
 * Minimal splice list turning `before` into `after` by common prefix and
 * suffix. A one-character typing edit is a single retain+insert — this is
 * what makes a keystroke cost proportional to the edit (DM-4.3).
 */
export function replaceChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  let start = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (start < maxPrefix && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const changes: TextChange[] = [];
  if (start > 0) changes.push({ retain: start });
  const removed = before.slice(start, endBefore);
  if (removed.length > 0) changes.push({ delete: removed.length });
  const inserted = after.slice(start, endAfter);
  if (inserted.length > 0) changes.push({ insert: inserted });
  const tailRetain = before.length - endBefore;
  if (tailRetain > 0) changes.push({ retain: tailRetain });
  return changes;
}

/**
 * EB-7 caret math: where does a caret at `position` (a selection boundary,
 * in code units) land after these changes are applied? A splice strictly
 * before the caret shifts it; at or after the caret it does not; a delete
 * covering the caret collapses it to the splice point — never beyond it.
 */
export function caretAfterChanges(changes: readonly TextChange[], position: number): number {
  let offset = 0; // edit position in the OLD string
  let caret = position;
  for (const change of changes) {
    if ("retain" in change) {
      offset += change.retain;
      continue;
    }
    if ("insert" in change) {
      // Strictly before the caret pushes it right; exactly AT the caret it
      // does not move (the writer's own typing is the at-caret case and
      // adjusts the caret itself).
      if (offset < position) caret += change.insert.length;
      continue;
    }
    if ("delete" in change) {
      const end = offset + change.delete;
      if (end <= position) {
        caret -= change.delete; // entirely before the caret
      } else if (offset < position) {
        caret = offset; // covered the caret: collapse to the splice point (EB-7.1)
      }
      offset = end;
      continue;
    }
  }
  return Math.max(0, caret);
}
