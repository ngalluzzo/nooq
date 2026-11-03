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

export const tablesPlugin = definePlugin({
  id: "nooq.tables", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [table, tableRow, tableCell], commands: [insertTable, addRowAfter] },
});

export const TABLES_VERSION = tablesPlugin.version;
