/**
 * The table views: the shell (grid), the row (equal-width cells — a row's
 * width is ITS OWN cell count, so a ragged merge renders honestly as a
 * narrower row), and the cell (the surface's text editor + navigation).
 *
 * Navigation is view-local through the DOM (the drag-handle pattern):
 * caret movement is not an edit and is not a transaction. Tab crosses
 * cells and wraps rows; Tab past the last cell of the last row RUNS the
 * add-row command (that IS an edit) and lands in the new row's first
 * cell. Enter steps down the column, adding a row when stepping past the
 * last. Shift+Tab walks back.
 */
import { defineDOMPlugin, defineTextPolicy, insertAfterSelection, type BlockViewContext } from "@nooq/plugins/dom";
import { defineAction } from "@nooq/plugins";
import { blockRow } from "@nooq/design";
import { table, tableCell, tableRow, tablesPlugin, addColumn, removeColumn, moveColumn, completeRow, toggleHeaderRow } from "./index.ts";

/** From a focused cell, its table id — or null outside tables. */
type TableView = { roots: readonly string[]; blocks: Record<string, { children: readonly string[]; type: string }> };
function tableOf(ctx: { block: string; snapshot: unknown }): string | null {
  const view = ctx.snapshot as unknown as TableView;
  let current: string | undefined = ctx.block;
  for (let depth = 0; depth < 3 && current !== undefined; depth++) {
    current = Object.keys(view.blocks).find(id => view.blocks[id]!.children.includes(current!));
    if (current !== undefined && view.blocks[current]!.type === "nooq.table/v1") return current;
  }
  return null;
}
function rowOf(ctx: { block: string; snapshot: unknown }): string | null {
  const view = ctx.snapshot as unknown as TableView;
  return Object.keys(view.blocks).find(id => view.blocks[id]!.children.includes(ctx.block)) ?? null;
}
function columnOf(ctx: { block: string; snapshot: unknown }): number {
  const view = ctx.snapshot as unknown as TableView;
  const row = rowOf(ctx);
  return row === null ? -1 : (view.blocks[row]!.children as readonly string[]).indexOf(ctx.block);
}

const focusCell = (root: HTMLElement, blockId: string): void => {
  const shell = root.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(blockId)}"]`);
  (shell?.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
};

export const tablesDOM = defineDOMPlugin({
  id: "nooq.tables.dom", forPlugin: tablesPlugin,
  // The slash entry ships with the plugin (§7): hosts without tables never
  // see the action, and the action's command is always registered.
  menus: [{ id: "insert:nooq.table/v1", label: "Table", glyph: "⊞", command: "nooq.table.insert", args: ctx => insertAfterSelection(ctx) }],
  // Column gestures where the caret is: the toolbar acts on the focused
  // cell's column (its position derived per invocation, never cached).
  actions: [
    defineAction({ id: "nooq.table.action.delete-column", label: "Delete column", placements: ["toolbar"], command: removeColumn,
      args: ctx => ({ table: tableOf(ctx) as string, at: columnOf(ctx) }), when: ctx => tableOf(ctx) !== null }),
    defineAction({ id: "nooq.table.action.move-column-left", label: "Move column left", placements: ["toolbar"], command: moveColumn,
      args: ctx => ({ table: tableOf(ctx) as string, from: columnOf(ctx), to: columnOf(ctx) - 1 }), when: ctx => tableOf(ctx) !== null && columnOf(ctx) > 0 }),
    defineAction({ id: "nooq.table.action.move-column-right", label: "Move column right", placements: ["toolbar"], command: moveColumn,
      args: ctx => ({ table: tableOf(ctx) as string, from: columnOf(ctx), to: columnOf(ctx) + 1 }), when: ctx => tableOf(ctx) !== null }),
    defineAction({ id: "nooq.table.action.toggle-header", label: "Toggle header row", placements: ["toolbar"], command: toggleHeaderRow,
      args: ctx => ({ row: rowOf(ctx) as string }), when: ctx => tableOf(ctx) !== null }),
  ],
  views: [
    { type: table.type, mount(ctx) {
      const element = document.createElement("div");
      element.className = "nq-table";
      const inner = document.createElement("div");
      inner.className = "nq-table-inner";
      inner.append(ctx.children.element);
      // The growth gestures: a row button below, a column button at the right —
      // each one transaction, each visible always (a table grows both ways).
      const growRow = document.createElement("button");
      growRow.type = "button"; growRow.className = "nq-table-grow nq-table-grow-row"; growRow.textContent = "+"; growRow.setAttribute("aria-label", "Add row");
      growRow.addEventListener("click", () => {
        const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[] }> };
        const rows = view.blocks[ctx.block]?.children ?? [];
        const last = rows[rows.length - 1];
        if (last !== undefined) void ctx.run("nooq.table.add-row", { afterRow: last });
      });
      const growColumn = document.createElement("button");
      growColumn.type = "button"; growColumn.className = "nq-table-grow nq-table-grow-column"; growColumn.textContent = "+"; growColumn.setAttribute("aria-label", "Add column");
      growColumn.addEventListener("click", () => { void ctx.run("nooq.table.add-column", { table: ctx.block }); });
      const bar = document.createElement("div");
      bar.className = "nq-table-bar";
      bar.append(growRow, growColumn);
      element.append(inner, bar);
      return { element, update() {} };
    } },
    { type: tableRow.type, mount(ctx) {
      const element = document.createElement("div");
      element.className = "nq-table-row";
      element.style.display = "grid";
      element.style.gridTemplateColumns = `repeat(${Math.max(1, ctx.snapshot().blocks[ctx.block]?.children.length ?? 1)}, minmax(4rem, 1fr))`;
      element.append(ctx.children.element);
      // The ragged repair (0015's public decision, rendered): a short row shows
      // its gap as a dashed ghost cell with the one-transaction fix.
      const ghost = document.createElement("button");
      ghost.type = "button"; ghost.className = "nq-table-ghost"; ghost.textContent = "+";
      ghost.setAttribute("aria-label", "Complete this row");
      ghost.addEventListener("click", () => { void ctx.run("nooq.table.complete-row", { row: ctx.block }); });
      return { element, update(block) {
        const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[] }> };
        const tableId = Object.keys(view.blocks).find(tid => view.blocks[tid]!.children.includes(ctx.block));
        const widest = tableId === undefined ? 0 : Math.max(...(view.blocks[tableId]!.children.map(row => view.blocks[row]!.children.length)));
        const short = block.children.length < widest;
        if (short && !element.contains(ghost)) element.append(ghost);
        if (!short && element.contains(ghost)) ghost.remove();
        element.style.gridTemplateColumns = `repeat(${Math.max(1, block.children.length + (short ? 1 : 0))}, minmax(4rem, 1fr))`;
        element.classList.toggle("nq-table-header-row", block.fields.header === true);
      } };
    } },
    { type: tableCell.type,
      textPolicy: defineTextPolicy({ defaultMode: "plain", enter: "newline" }),
      mount(ctx: BlockViewContext) {
        const text = ctx.mountTextEditor({ label: "Table cell" });
        const editor = text.element as HTMLTextAreaElement;
        editor.classList.add("nq-table-cell-input");
        const element = blockRow({ content: [editor, ctx.children.element], kind: "paragraph", actor: "human" });
        const body = element.querySelector<HTMLElement>(".nq-block-body");
        if (body) body.classList.add("nq-table-cell");

        // Navigation: view-local; only row-creation is a command.
        const position = (): { row: string; rows: readonly string[]; cells: readonly string[]; at: number } | null => {
          const view = ctx.snapshot() as unknown as { roots: readonly string[]; blocks: Record<string, { children: readonly string[]; type: string }> };
          const id = ctx.block;
          const row = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(id));
          if (row === undefined) return null;
          const tableId = Object.keys(view.blocks).find(tid => view.blocks[tid]!.children.includes(row));
          if (tableId === undefined) return null;
          const rows = view.blocks[tableId]!.children;
          const cells = view.blocks[row]!.children;
          return { row, rows, cells, at: cells.indexOf(id) };
        };
        const step = (target: () => string | undefined): void => {
          const to = target();
          if (to === undefined) return;
          const root = element.closest<HTMLElement>(".nq-editor");
          if (root) focusCell(root, to);
        };
        editor.addEventListener("keydown", (event) => {
          if (event.key !== "Tab" && !(event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)) return;
          const here = position();
          if (here === null) return;
          const last = here.cells.length - 1;
          if (event.key === "Tab" && !event.shiftKey) {
            event.preventDefault();
            if (here.at < last) { step(() => here.cells[here.at + 1]!); return; }
            const rowIndex = here.rows.indexOf(here.row);
            if (rowIndex < here.rows.length - 1) { step(() => (ctx.snapshot().blocks[here.rows[rowIndex + 1]!]!.children as readonly string[])[0]); return; }
            // Past the last cell of the last row: create a row (an edit!), land in its first cell.
            void ctx.run("nooq.table.add-row", { afterRow: here.row });
            return;
          }
          if (event.key === "Tab" && event.shiftKey) {
            event.preventDefault();
            if (here.at > 0) { step(() => here.cells[here.at - 1]!); return; }
            const rowIndex = here.rows.indexOf(here.row);
            if (rowIndex > 0) { const prev = (ctx.snapshot().blocks[here.rows[rowIndex - 1]!]!.children as readonly string[]); step(() => prev[prev.length - 1]); }
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const column = here.at;
            const rowIndex = here.rows.indexOf(here.row);
            if (rowIndex < here.rows.length - 1) { step(() => (ctx.snapshot().blocks[here.rows[rowIndex + 1]!]!.children as readonly string[])[column]); return; }
            void ctx.run("nooq.table.add-row", { afterRow: here.row });
          }
        });
        return { element, update() {}, destroy() { text.destroy(); } };
      } },
  ],
});
