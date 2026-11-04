/**
 * Tables (0015 stage 1): a table is a tree — table → row → cell — and every
 * op is an ordinary block op the model already owns. Cells hold inline text
 * (the CRDT merges two writers in one cell); rows are DM-4 blocks (drag,
 * attribute, supersede); the grid view renders what is THERE, raggedness
 * included, honestly (0015's public decision).
 */
import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";

export const table = defineBlock({
  type: "nooq.table/v1", label: "Table",
  text: "none",
  // headerColumns is the table's birthright (stage 5): the array of column
  // indices styled as headers — present from creation so every toggle has
  // an old value to invert (the colspan lesson, applied by default).
  create: () => ({ fields: { headerColumns: [] as import("@nooq/core").JsonValue[] } }),
  diagnose: () => [],
});
export const tableRow = defineBlock({
  type: "nooq.table-row/v1", label: "Row",
  text: "none", create: () => ({ fields: {} }), diagnose: () => [],
});
export const tableCell = defineBlock({
  type: "nooq.table-cell/v1", label: "Cell",
  text: "inline",
  // colspan is a birthright (stage 4): present from creation so every merge
  // write has an old value to invert — undo round-trips (DM-4.10's stated
  // first-set limit never fires for spans).
  create: () => ({ fields: { colspan: 1, color: "none" }, text: { s: "", marks: [] } }),
  diagnose: () => [],
});

/** The starter shape: 2 rows × 2 cells, one transaction (insertColumns' discipline). */
export const insertTable = defineCommand<{ parent: string | null; index?: number; clearBlock?: string }>({
  id: "nooq.table.insert", label: "Insert table",
  validateArgs: (a): a is { parent: string | null; index?: number; clearBlock?: string } => !!a && typeof a === "object" && ((a as { parent?: unknown }).parent === null || typeof (a as { parent?: unknown }).parent === "string") && ((a as { index?: unknown }).index === undefined || Number.isInteger((a as { index?: unknown }).index as number)) && ((a as { clearBlock?: unknown }).clearBlock === undefined || typeof (a as { clearBlock?: unknown }).clearBlock === "string"),
  prepare(ctx, args) {
    if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
    const ops: import("@nooq/core").Op[] = [];
    if (args.clearBlock !== undefined) {
      if (!ctx.isAlive(args.clearBlock) || ctx.snapshot.blocks[args.clearBlock]?.text?.s !== "/") return { status: "not-applicable" };
      ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
    }
    const t = ctx.createBlock(table.type);
    const firstCell = ctx.createBlock(tableCell.type);
    ops.push({ op: "insert", block: t, parent: args.parent, ...(args.index !== undefined ? { index: args.index } : {}) });
    for (let r = 0; r < 2; r++) {
      const row = ctx.createBlock(tableRow.type);
      ops.push({ op: "insert", block: row, parent: t.id, index: r });
      for (let c = 0; c < 2; c++) {
        const cell = r === 0 && c === 0 ? firstCell : ctx.createBlock(tableCell.type);
        ops.push({ op: "insert", block: cell, parent: row.id, index: c });
      }
    }
    return { status: "ready", intent: "insert-table", ops, selection: { block: firstCell.id, anchor: 0, head: 0 } };
  },
});

/** Add a row after a given row, its width matching that row (the honest width). */
export const addRowAfter = defineCommand<{ afterRow: string }>({
  id: "nooq.table.add-row", label: "Add row",
  validateArgs: (a): a is { afterRow: string } => !!a && typeof a === "object" && typeof (a as { afterRow?: unknown }).afterRow === "string",
  prepare(ctx, { afterRow }) {
    if (!ctx.isAlive(afterRow)) return { status: "not-applicable" };
    const row = ctx.snapshot.blocks[afterRow]!;
    if (row.type !== tableRow.type) return { status: "not-applicable" };
    const tableId = Object.keys(ctx.snapshot.blocks).find(id => (ctx.snapshot.blocks[id]!.children as readonly string[]).includes(afterRow));
    if (tableId === undefined) return { status: "not-applicable" };
    const at = (ctx.snapshot.blocks[tableId]!.children as readonly string[]).indexOf(afterRow);
    const width = row.children.length;
    const newRow = ctx.createBlock(tableRow.type);
    const ops: import("@nooq/core").Op[] = [{ op: "insert", block: newRow, parent: tableId, index: at + 1 }];
    let firstCell: string | undefined;
    for (let c = 0; c < width; c++) {
      const cell = ctx.createBlock(tableCell.type);
      if (c === 0) firstCell = cell.id;
      ops.push({ op: "insert", block: cell, parent: newRow.id, index: c });
    }
    return { status: "ready", intent: "add-row", ops, selection: { block: firstCell ?? newRow.id, anchor: 0, head: 0 } };
  },
});



/** The table's honest width: the widest row (ragged rows stay short, by decision). */
function maxWidth(view: { blocks: Record<string, { children: readonly string[] }> }, tableId: string): number {
  let width = 0;
  for (const row of view.blocks[tableId]?.children ?? []) width = Math.max(width, view.blocks[row]?.children.length ?? 0);
  return width;
}

/** Add a column at index `at` (default: the end) — ONE transaction: a cell into every row wide enough to have that column. Rows already short stay short (0015: honest raggedness). */
export const addColumn = defineCommand<{ table: string; at?: number }>({
  id: "nooq.table.add-column", label: "Add column",
  validateArgs: (a): a is { table: string; at?: number } => !!a && typeof a === "object" && typeof (a as { table?: unknown }).table === "string" && ((a as { at?: unknown }).at === undefined || Number.isInteger((a as { at?: unknown }).at as number)),
  prepare(ctx, args) {
    if (!ctx.isAlive(args.table) || ctx.snapshot.blocks[args.table]?.type !== table.type) return { status: "not-applicable" };
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[]; type: string }> };
    const at = args.at ?? maxWidth(view, args.table);
    const ops: import("@nooq/core").Op[] = [];
    let first: string | undefined;
    for (const row of view.blocks[args.table]!.children) {
      if ((view.blocks[row]!.children.length) < at) continue; // already short: stays short
      const cell = ctx.createBlock(tableCell.type);
      if (first === undefined) first = cell.id;
      ops.push({ op: "insert", block: cell, parent: row, index: at });
    }
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "add-column", ops, selection: first !== undefined ? { block: first, anchor: 0, head: 0 } : undefined };
  },
});

/** Remove column `at` — ONE transaction, the cell from every row that has one. The last column is guarded: a table keeps at least one. */
export const removeColumn = defineCommand<{ table: string; at: number }>({
  id: "nooq.table.remove-column", label: "Delete column",
  validateArgs: (a): a is { table: string; at: number } => !!a && typeof a === "object" && typeof (a as { table?: unknown }).table === "string" && Number.isInteger((a as { at?: unknown }).at as number),
  prepare(ctx, args) {
    if (!ctx.isAlive(args.table) || ctx.snapshot.blocks[args.table]?.type !== table.type) return { status: "not-applicable" };
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[] }> };
    if (maxWidth(view, args.table) <= 1) return { status: "not-applicable" }; // the last column stays
    const ops: import("@nooq/core").Op[] = [];
    for (const row of view.blocks[args.table]!.children) {
      const cells = view.blocks[row]!.children;
      if (args.at < cells.length) ops.push({ op: "delete", block: cells[args.at]! });
    }
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "remove-column", ops };
  },
});

/** Move column `from` to `to` — ONE transaction of moves, one per row that has both columns. */
export const moveColumn = defineCommand<{ table: string; from: number; to: number }>({
  id: "nooq.table.move-column", label: "Move column",
  validateArgs: (a): a is { table: string; from: number; to: number } => !!a && typeof a === "object" && Number.isInteger((a as { from?: unknown }).from as number) && Number.isInteger((a as { to?: unknown }).to as number),
  prepare(ctx, args) {
    if (!ctx.isAlive(args.table) || ctx.snapshot.blocks[args.table]?.type !== table.type) return { status: "not-applicable" };
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[] }> };
    const width = maxWidth(view, args.table);
    if (args.from < 0 || args.from >= width || args.to < 0 || args.to >= width || args.from === args.to) return { status: "not-applicable" };
    const ops: import("@nooq/core").Op[] = [];
    for (const row of view.blocks[args.table]!.children) {
      const cells = view.blocks[row]!.children;
      if (Math.max(args.from, args.to) >= cells.length) continue; // short row: untouched
      ops.push({ op: "move", block: cells[args.from]!, newParent: row, index: args.to });
    }
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "move-column", ops };
  },
});

/** The ragged repair (0015's public decision): complete a short row to the table's width, ONE transaction. */
export const completeRow = defineCommand<{ row: string }>({
  id: "nooq.table.complete-row", label: "Complete row",
  validateArgs: (a): a is { row: string } => !!a && typeof a === "object" && typeof (a as { row?: unknown }).row === "string",
  prepare(ctx, { row: id }) {
    if (!ctx.isAlive(id) || ctx.snapshot.blocks[id]?.type !== tableRow.type) return { status: "not-applicable" };
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[] }> };
    const tableId = Object.keys(view.blocks).find(tid => view.blocks[tid]!.children.includes(id));
    if (tableId === undefined) return { status: "not-applicable" };
    const width = maxWidth(view, tableId);
    const cells = view.blocks[id]!.children;
    if (cells.length >= width) return { status: "not-applicable" }; // not short
    const ops: import("@nooq/core").Op[] = [];
    for (let c = cells.length; c < width; c++) ops.push({ op: "insert", block: ctx.createBlock(tableCell.type), parent: id, index: c });
    return { status: "ready", intent: "complete-row", ops };
  },
});

/** Paste into a range (stage 3): a pipes-or-TSV clipboard fills the
 *  rectangle from its anchor — ONE transaction of textEdits. The fill
 *  TRUNCATES honestly at the table's bounds: no auto-grow, no invented rows
 *  (0015's grammar — the model does not guess intent). */
export const pasteIntoRange = defineCommand<{ cells: readonly (readonly string[])[]; values: readonly (readonly string[])[] }>({
  id: "nooq.table.paste-range", label: "Paste into cells",
  validateArgs: (a): a is { cells: readonly (readonly string[])[]; values: readonly (readonly string[])[] } => {
    if (!a || typeof a !== "object") return false;
    const rowsOf = (value: unknown): value is readonly (readonly string[])[] => Array.isArray(value) && value.every(row => Array.isArray(row) && row.every(cell => typeof cell === "string"));
    return Array.isArray((a as { cells?: unknown }).cells) && rowsOf((a as { cells?: unknown }).cells) && Array.isArray((a as { values?: unknown }).values) && rowsOf((a as { values?: unknown }).values);
  },
  prepare(ctx, { cells, values }) {
    if (cells.length === 0 || values.length === 0) return { status: "not-applicable" };
    const ops: import("@nooq/core").Op[] = [];
    for (const [rowAt, row] of values.entries()) {
      const targetRow = cells[rowAt];
      if (targetRow === undefined) break; // the clipboard exceeds the rectangle: truncate honestly
      for (const [column, value] of row.entries()) {
        const cell = targetRow[column];
        if (cell === undefined) break; // wider than the rectangle: same honesty
        if (!ctx.isAlive(cell)) continue;
        const text = ctx.snapshot.blocks[cell]!.text;
        const current = text?.s ?? "";
        if (current === value) continue; // identical: not an edit
        ops.push(current.length === 0
          ? { op: "textEdit", block: cell, changes: [{ insert: value }] }
          : { op: "textEdit", block: cell, changes: [{ delete: current.length }, { insert: value }] });
      }
    }
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "paste-range", ops };
  },
});

/** The cell color palette — themed, named, fixed (a payloaded picker is
 *  the link mechanism's job; these are the surface's own vocabulary). */
export const CELL_COLORS: readonly string[] = Object.freeze(["none", "highlight", "note", "flag"]);

/** Cycle a cell's color through the palette — one field write; undo
 *  round-trips (the birthright guarantees the old value). */
export const cycleCellColor = defineCommand<{ cell: string }>({
  id: "nooq.table.cell-color", label: "Cell color",
  validateArgs: (a): a is { cell: string } => !!a && typeof a === "object" && typeof (a as { cell?: unknown }).cell === "string",
  prepare(ctx, { cell: id }) {
    if (!ctx.isAlive(id) || ctx.snapshot.blocks[id]?.type !== tableCell.type) return { status: "not-applicable" };
    const current = typeof ctx.snapshot.blocks[id]!.fields.color === "string" ? (ctx.snapshot.blocks[id]!.fields.color as string) : "none";
    const next = CELL_COLORS[(CELL_COLORS.indexOf(current) + 1) % CELL_COLORS.length]!;
    if (next === current) return { status: "not-applicable" }; // single-color palette: a no-op is not a transaction
    return { status: "ready", intent: "cell-color", ops: [{ op: "setField", block: id, key: "color", value: next }] };
  },
});

/** Header columns (stage 5): ONE field write on the table flips the column —
 *  the array of indices, undo round-trips through the birthright array. */
export const toggleHeaderColumn = defineCommand<{ table: string; column: number }>({
  id: "nooq.table.toggle-header-column", label: "Toggle header column",
  validateArgs: (a): a is { table: string; column: number } => !!a && typeof a === "object" && typeof (a as { table?: unknown }).table === "string" && Number.isInteger((a as { column?: unknown }).column as number),
  prepare(ctx, { table: id, column }) {
    if (!ctx.isAlive(id) || ctx.snapshot.blocks[id]?.type !== table.type) return { status: "not-applicable" };
    const current: number[] = Array.isArray(ctx.snapshot.blocks[id]!.fields.headerColumns) ? [...(ctx.snapshot.blocks[id]!.fields.headerColumns as number[])] : [];
    const at = current.indexOf(column);
    if (at >= 0) current.splice(at, 1); else current.push(column);
    return { status: "ready", intent: "toggle-header-column", ops: [{ op: "setField", block: id, key: "headerColumns", value: current as unknown as import("@nooq/core").JsonValue }] };
  },
});

/** Merged cells (0015 stage 4): merge is DELETION + a span field — the
 *  origin cell carries colspan, the covered cells tombstone in the same
 *  transaction; split is the exact inverse (restore + clear), so undo
 *  (DM-4.10) round-trips both for free. A merged row is ragged *on purpose*,
 *  the field naming the intent — the ghost compares SPAN-SUM to width. */
export const mergeCells = defineCommand<{ cells: readonly string[] }>({
  id: "nooq.table.merge", label: "Merge cells",
  validateArgs: (a): a is { cells: readonly string[] } => !!a && typeof a === "object" && Array.isArray((a as { cells?: unknown }).cells) && (a as { cells: unknown[] }).cells.every(id => typeof id === "string"),
  prepare(ctx, { cells }) {
    if (cells.length < 2) return { status: "not-applicable" }; // merging needs at least two
    // All cells must be alive siblings of ONE row (colspan v1; rowspan is stage 2's flattened grid).
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[]; type: string }> };
    const rows = new Set<string>();
    for (const cell of cells) {
      if (!ctx.isAlive(cell)) return { status: "not-applicable" };
      const row = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(cell));
      if (row === undefined) return { status: "not-applicable" };
      rows.add(row);
    }
    if (rows.size !== 1) return { status: "not-applicable" };
    // The origin: the LEFTMOST selected cell (deterministic — the merge is the
    // same transaction whoever drags the range).
    const row = [...rows][0]!;
    const order = (view.blocks[row]!.children as readonly string[]).filter(id => cells.includes(id));
    if (order.length !== cells.length) return { status: "not-applicable" };
    const origin = order[0]!, covered = order.slice(1);
    const ops: import("@nooq/core").Op[] = [];
    const existing = ctx.snapshot.blocks[origin]!.fields.colspan;
    const span = (typeof existing === "number" ? existing : 1) + covered.length;
    ops.push({ op: "setField", block: origin, key: "colspan", value: span });
    for (const cell of covered) ops.push({ op: "delete", block: cell });
    return { status: "ready", intent: "merge-cells", ops };
  },
});

/** Split: the exact inverse — restore colspan-1 covered cells, clear the span. */
export const splitCell = defineCommand<{ cell: string }>({
  id: "nooq.table.split", label: "Split cell",
  validateArgs: (a): a is { cell: string } => !!a && typeof a === "object" && typeof (a as { cell?: unknown }).cell === "string",
  prepare(ctx, { cell: id }) {
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    const span = ctx.snapshot.blocks[id]!.fields.colspan;
    if (typeof span !== "number" || span < 2) return { status: "not-applicable" }; // not merged
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[] }> };
    const row = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(id));
    if (row === undefined) return { status: "not-applicable" };
    const cells = view.blocks[row]!.children as readonly string[];
    const at = cells.indexOf(id);
    const ops: import("@nooq/core").Op[] = [{ op: "setField", block: id, key: "colspan", value: 1 }]; // the birthright, not absence
    for (let i = 1; i < span; i++) ops.push({ op: "insert", block: ctx.createBlock(tableCell.type), parent: row, index: at + i });
    return { status: "ready", intent: "split-cell", ops };
  },
});

/** Selection ranges (stage 3): clear the rectangle's cells — ONE transaction
 *  of textEdits (empty cells stay empty; clearing an all-empty range is not
 *  a transaction). The RANGE itself is view state, never document state —
 *  caret movement is not an edit, and neither is selection. */
export const clearRange = defineCommand<{ cells: readonly string[] }>({
  id: "nooq.table.clear-range", label: "Clear cells",
  validateArgs: (a): a is { cells: readonly string[] } => !!a && typeof a === "object" && Array.isArray((a as { cells?: unknown }).cells) && (a as { cells: unknown[] }).cells.every(id => typeof id === "string"),
  prepare(ctx, { cells }) {
    const ops: import("@nooq/core").Op[] = [];
    for (const cell of cells) {
      if (!ctx.isAlive(cell)) continue;
      const text = ctx.snapshot.blocks[cell]!.text;
      if (text === undefined || text.s.length === 0) continue; // empty stays empty
      ops.push({ op: "textEdit", block: cell, changes: [{ delete: text.s.length }] });
    }
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "clear-range", ops };
  },
});

/** Column sizing: the widths are ONE field on the table — relative weights,
 *  low contention, LWW by design (0015: "no content"). The minimum is a
 *  fraction of total width; the gesture clamps, the field records. */
export const resizeColumn = defineCommand<{ table: string; column: number; deltaWeight: number }>({
  id: "nooq.table.resize-column", label: "Resize column",
  validateArgs: (a): a is { table: string; column: number; deltaWeight: number } => !!a && typeof a === "object" && typeof (a as { table?: unknown }).table === "string" && Number.isInteger((a as { column?: unknown }).column as number) && typeof (a as { deltaWeight?: unknown }).deltaWeight === "number",
  prepare(ctx, { table: id, column, deltaWeight }) {
    if (!ctx.isAlive(id) || ctx.snapshot.blocks[id]?.type !== table.type) return { status: "not-applicable" };
    const view = ctx.snapshot as unknown as { blocks: Record<string, { children: readonly string[] }> };
    const width = maxWidth(view, id);
    if (column < 0 || column + 1 >= width) return { status: "not-applicable" }; // the last boundary is the table's edge
    const current = ctx.snapshot.blocks[id]!.fields.widths;
    const weights: number[] = Array.isArray(current) && current.every(w => typeof w === "number" && w > 0) ? [...current as number[]] : Array.from({ length: width }, () => 1);
    while (weights.length < width) weights.push(1);
    const MIN = 0.15;
    const delta = Math.max(deltaWeight, MIN - weights[column]!);
    const grow = Math.min(delta, weights[column + 1]! - MIN);
    if (grow <= 0) return { status: "not-applicable" }; // clamped out: no-op is not a transaction
    weights[column]! += grow;
    weights[column + 1]! -= grow;
    return { status: "ready", intent: "resize-column", ops: [{ op: "setField", block: id, key: "widths", value: weights }] };
  },
});

/** A header is a row property (the row is a block; the field is data). */
export const toggleHeaderRow = defineCommand<{ row: string }>({
  id: "nooq.table.toggle-header", label: "Toggle header row",
  validateArgs: (a): a is { row: string } => !!a && typeof a === "object" && typeof (a as { row?: unknown }).row === "string",
  prepare(ctx, { row: id }) {
    if (!ctx.isAlive(id) || ctx.snapshot.blocks[id]?.type !== tableRow.type) return { status: "not-applicable" };
    const isHeader = ctx.snapshot.blocks[id]!.fields.header === true;
    return { status: "ready", intent: "toggle-header", ops: [{ op: "setField", block: id, key: "header", value: !isHeader }] };
  },
});

export const tablesPlugin = definePlugin({
  id: "nooq.tables", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [table, tableRow, tableCell], commands: [insertTable, addRowAfter, addColumn, removeColumn, moveColumn, completeRow, toggleHeaderRow, toggleHeaderColumn, resizeColumn, clearRange, pasteIntoRange, mergeCells, splitCell, cycleCellColor] },
});

export const TABLES_VERSION = tablesPlugin.version;
