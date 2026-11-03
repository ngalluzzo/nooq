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
  text: "none", create: () => ({ fields: {} }), diagnose: () => [],
});
export const tableRow = defineBlock({
  type: "nooq.table-row/v1", label: "Row",
  text: "none", create: () => ({ fields: {} }), diagnose: () => [],
});
export const tableCell = defineBlock({
  type: "nooq.table-cell/v1", label: "Cell",
  text: "inline",
  create: () => ({ fields: {}, text: { s: "", marks: [] } }),
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
  contributes: { blocks: [table, tableRow, tableCell], commands: [insertTable, addRowAfter, addColumn, removeColumn, moveColumn, completeRow, toggleHeaderRow] },
});

export const TABLES_VERSION = tablesPlugin.version;
