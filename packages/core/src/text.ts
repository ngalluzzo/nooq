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

/** Split a rendered span into runs for a splice, preserving UTF-16 marks. */
export function markedInserts(text: { s: string; marks: readonly (readonly string[])[] }, from = 0, to = text.s.length): Extract<TextChange, { insert: string }>[] {
  const out: Extract<TextChange, { insert: string }>[] = [];
  while (from < to) {
    const marks = text.marks[from] ?? [];
    let end = from + 1;
    while (end < to) {
      const next = text.marks[end] ?? [];
      if (next.length !== marks.length || next.some((name, index) => name !== marks[index])) break;
      end++;
    }
    out.push({ insert: text.s.slice(from, end), ...(marks.length ? { marks: [...marks] } : {}) });
    from = end;
  }
  return out;
}

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
 * DM-14.3: one change list equivalent to applying `first`, then `second`
 * (written against first's result). A typing burst's keystrokes compose into
 * the one transaction the burst seals. Inserted-then-deleted text vanishes;
 * setMarks over inserted text becomes the insert's marks.
 */
export function composeTextChanges(first: readonly TextChange[], second: readonly TextChange[]): TextChange[] {
  const out: TextChange[] = [];
  let index = 0;
  let offset = 0; // into first[index]
  const advance = (length: number, total: number) => {
    offset += length;
    if (offset === total) {
      index++;
      offset = 0;
    }
  };
  /** Take n units of first's output, piece by piece; first's deletes pass through on the way. */
  const consume = (n: number, take: (piece: { insert: string; marks?: string[] } | { retain: number; setMarks?: string[] | null }) => void) => {
    while (n > 0) {
      const change = first[index];
      if (change === undefined) {
        take({ retain: n }); // past first's end: its implicit trailing retain of the base
        return;
      }
      if ("delete" in change) {
        pushChange(out, change);
        index++;
        continue;
      }
      if ("insert" in change) {
        const length = Math.min(n, change.insert.length - offset);
        take({ insert: change.insert.slice(offset, offset + length), ...(change.marks !== undefined ? { marks: change.marks } : {}) });
        advance(length, change.insert.length);
        n -= length;
      } else {
        const length = Math.min(n, change.retain - offset);
        take("setMarks" in change ? { retain: length, setMarks: change.setMarks } : { retain: length });
        advance(length, change.retain);
        n -= length;
      }
    }
  };
  for (const change of second) {
    if ("insert" in change) {
      pushChange(out, change);
    } else if ("delete" in change) {
      consume(change.delete, (piece) => {
        if ("retain" in piece) pushChange(out, { delete: piece.retain }); // inserted, then deleted: nothing
      });
    } else {
      const setMarks = "setMarks" in change ? change.setMarks : undefined;
      consume(change.retain, (piece) => {
        if ("insert" in piece) {
          if (setMarks === undefined) pushChange(out, piece);
          else pushChange(out, setMarks === null || setMarks.length === 0 ? { insert: piece.insert } : { insert: piece.insert, marks: [...setMarks] });
        } else {
          const marks = setMarks !== undefined ? setMarks : piece.setMarks;
          pushChange(out, marks === undefined ? { retain: piece.retain } : { retain: piece.retain, setMarks: marks });
        }
      });
    }
  }
  // second's implicit trailing retain: the rest of first passes through.
  for (; index < first.length; index++, offset = 0) {
    const change = first[index]!;
    if ("delete" in change) pushChange(out, change);
    else if ("insert" in change) pushChange(out, { ...change, insert: change.insert.slice(offset) });
    else pushChange(out, { ...change, retain: change.retain - offset });
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (!("retain" in last) || "setMarks" in last) break;
    out.pop(); // trailing plain retains may be omitted (DM-4.3)
  }
  return out;
}

const markKey = (marks: readonly string[] | null | undefined) => (marks === null ? "null" : sortedUnique(marks ?? []).join("\u0000"));

/** Append, merging with a neighbor of the same kind; zero-length steps vanish. */
function pushChange(out: TextChange[], change: TextChange): void {
  const size = "retain" in change ? change.retain : "delete" in change ? change.delete : change.insert.length;
  if (size === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined) {
    if ("delete" in last && "delete" in change) {
      out[out.length - 1] = { delete: last.delete + change.delete };
      return;
    }
    if ("insert" in last && "insert" in change && markKey(last.marks) === markKey(change.marks)) {
      out[out.length - 1] = { ...last, insert: last.insert + change.insert };
      return;
    }
    if ("retain" in last && "retain" in change && ("setMarks" in last) === ("setMarks" in change)) {
      const lastMarks = "setMarks" in last ? last.setMarks : undefined;
      const marks = "setMarks" in change ? change.setMarks : undefined;
      if (markKey(lastMarks) === markKey(marks)) {
        out[out.length - 1] = { ...last, retain: last.retain + change.retain };
        return;
      }
    }
  }
  out.push(change);
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
