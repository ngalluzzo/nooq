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
import { defineDOMPlugin, defineTextPolicy, type BlockViewContext } from "@nooq/plugins/dom";
import { blockRow } from "@nooq/design";
import { table, tableCell, tableRow, tablesPlugin } from "./index.ts";

const focusCell = (root: HTMLElement, blockId: string): void => {
  const shell = root.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(blockId)}"]`);
  (shell?.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
};

export const tablesDOM = defineDOMPlugin({
  id: "nooq.tables.dom", forPlugin: tablesPlugin,
  views: [
    { type: table.type, mount(ctx) {
      const element = document.createElement("div");
      element.className = "nq-table";
      element.append(ctx.children.element);
      return { element, update() {} };
    } },
    { type: tableRow.type, mount(ctx) {
      const element = document.createElement("div");
      element.className = "nq-table-row";
      element.style.display = "grid";
      element.style.gridTemplateColumns = `repeat(${Math.max(1, ctx.snapshot().blocks[ctx.block]?.children.length ?? 1)}, minmax(4rem, 1fr))`;
      element.append(ctx.children.element);
      return { element, update(block) {
        element.style.gridTemplateColumns = `repeat(${Math.max(1, block.children.length)}, minmax(4rem, 1fr))`;
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
