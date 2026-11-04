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
import { table, tableCell, tableRow, tablesPlugin, addColumn, removeColumn, moveColumn, completeRow, toggleHeaderRow, clearRange, pasteIntoRange, mergeCells, splitCell } from "./index.ts";

/** From a focused cell, its table id — or null outside tables. */
type TableView = { roots: readonly string[]; blocks: Record<string, { children: readonly string[]; type: string }> };
/** Action helpers: one scan per invocation (actions fire on click, never
 *  per-cell — the hot paths are the views, which read the context's tree). */
function tableOf(ctx: { block: string; snapshot: unknown }): string | null {
  const view = ctx.snapshot as unknown as TableView;
  const row = Object.keys(view.blocks).find(id => (view.blocks[id]!.children as readonly string[]).includes(ctx.block));
  if (row === undefined) return null;
  const table = Object.keys(view.blocks).find(id => (view.blocks[id]!.children as readonly string[]).includes(row));
  return table ?? null;
}
function rowOf(ctx: { block: string; snapshot: unknown }): string | null {
  const view = ctx.snapshot as unknown as TableView;
  return Object.keys(view.blocks).find(id => (view.blocks[id]!.children as readonly string[]).includes(ctx.block)) ?? null;
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
    defineAction({ id: "nooq.table.action.split", label: "Split merged cell", placements: ["toolbar"], command: splitCell,
      args: ctx => ({ cell: ctx.block }), when: ctx => tableOf(ctx) !== null && typeof (ctx.snapshot.blocks[ctx.block]?.fields as { colspan?: unknown } | undefined)?.colspan === "number" && ((ctx.snapshot.blocks[ctx.block]!.fields as { colspan: number }).colspan) >= 2 }),
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
      // Selection ranges: the range is VIEW state (never a transaction —
      // caret movement is not an edit, and neither is selection). Shift-click
      // anchors and extends; the rectangle highlights; Delete clears (one
      // transaction); Cmd+C copies pipes; Escape or a plain click exits.
      let range: { anchor: { row: number; col: number }; focus: { row: number; col: number } } | undefined;
      const cellIds = (): string[][] => {
        const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[] }> };
        return ((ctx.snapshot().blocks[ctx.block]?.children ?? []) as readonly string[])
          .map(row => ((ctx.snapshot().blocks[row]?.children ?? []) as readonly string[]).slice());
      };
      const cellBlockAt = (r: number, c: number): string | undefined => cellIds()[r]?.[c];
      const idOfCell = (id: string): { row: number; col: number } | undefined => {
        const grid = cellIds();
        for (let r = 0; r < grid.length; r++) { const c = grid[r]!.indexOf(id); if (c >= 0) return { row: r, col: c }; }
        return undefined;
      };
      const paint = (): void => {
        for (const shell of Array.from(element.querySelectorAll<HTMLElement>(".nq-table-cell"))) shell.classList.remove("nq-table-cell-selected");
        if (range === undefined) return;
        const r0 = Math.min(range.anchor.row, range.focus.row), r1 = Math.max(range.anchor.row, range.focus.row);
        const c0 = Math.min(range.anchor.col, range.focus.col), c1 = Math.max(range.anchor.col, range.focus.col);
        const grid = cellIds();
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const id = grid[r]?.[c];
          if (id === undefined) continue; // ragged: the rectangle clips honestly
          element.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(id)}"] .nq-table-cell`)?.classList.add("nq-table-cell-selected");
        }
      };
      const selectedCells = (): string[][] => {
        if (range === undefined) return [];
        const r0 = Math.min(range.anchor.row, range.focus.row), r1 = Math.max(range.anchor.row, range.focus.row);
        const c0 = Math.min(range.anchor.col, range.focus.col), c1 = Math.max(range.anchor.col, range.focus.col);
        const grid = cellIds();
        const rows: string[][] = [];
        for (let r = r0; r <= r1; r++) {
          const ids: string[] = [];
          for (let c = c0; c <= c1; c++) { const id = grid[r]?.[c]; if (id !== undefined) ids.push(id); }
          rows.push(ids); // ragged rows contribute fewer — the paste truncates against reality
        }
        return rows;
      };
      const pipesOf = (): string => {
        const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[]; text?: { s: string } }> };
        const grid = cellIds();
        const r0 = Math.min(range!.anchor.row, range!.focus.row), r1 = Math.max(range!.anchor.row, range!.focus.row);
        const c0 = Math.min(range!.anchor.col, range!.focus.col), c1 = Math.max(range!.anchor.col, range!.focus.col);
        const lines: string[] = [];
        for (let r = r0; r <= r1; r++) {
          const cells: string[] = [];
          for (let c = c0; c <= c1; c++) { const id = grid[r]?.[c]; cells.push(id !== undefined ? (view.blocks[id]!.text?.s ?? "") : ""); }
          lines.push(`| ${cells.join(" | ")} |`);
        }
        return lines.join("\n");
      };
      element.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        const shell = event.target.closest<HTMLElement>("[data-nq-block]");
        const cellShell = shell?.querySelector(".nq-table-cell") !== null && event.target.closest(".nq-table-cell") !== null ? shell : null;
        if (cellShell === null || shell === null) { if (event.shiftKey) return; range = undefined; paint(); return; } // plain click outside cells exits
        const at = idOfCell(shell.dataset.nqBlock!);
        if (at === undefined) return;
        if (event.shiftKey && range !== undefined) { range = { ...range, focus: at }; inner.focus({ preventScroll: true }); }
        else if (event.shiftKey) { range = { anchor: at, focus: at }; inner.focus({ preventScroll: true }); }
        else { range = undefined; }
        paint();
      });
      inner.setAttribute("tabindex", "0"); // range mode takes keys here
      inner.addEventListener("keydown", (event) => {
        if (range === undefined) return;
        const clearing = event.key === "Delete" || event.key === "Backspace";
        if (clearing) { event.preventDefault(); void ctx.run("nooq.table.clear-range", { cells: selectedCells().flat() }); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void navigator.clipboard?.writeText(pipesOf()); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
          event.preventDefault();
          void navigator.clipboard?.readText().then(text => {
            const trimmed = text.trim();
            if (trimmed === "") return;
            const isPipes = trimmed.split("\n").every(line => /^\|.*\|$/.test(line.trim()) && !/^\|[\s:|-]+\|$/.test(line.trim()));
            const values = isPipes
              ? trimmed.split("\n").map(line => line.trim().slice(1, -1).split("|").map(cell => cell.trim()))
              : trimmed.includes("\t") ? trimmed.split("\n").map(line => line.split("\t"))
              : [[trimmed]];
            void ctx.run("nooq.table.paste-range", { cells: selectedCells(), values });
          });
          return;
        }
        if (event.key.toLowerCase() === "m" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void ctx.run("nooq.table.merge", { cells: selectedCells().flat() }); return; }
        if (event.key.toLowerCase() === "m" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ctx.run("nooq.table.split", { cell: range.anchor.row >= 0 ? (cellIds()[range.anchor.row]?.[range.anchor.col] ?? "") : "" }); return; }
        if (event.key === "Escape") { range = undefined; paint(); }
      });
      // Column sizing: every row reads the same widths field, so the columns
      // align by construction; the live drag restyles rows directly, release
      // commits ONE setField (the model sees the gesture exactly once).
      const applyWidths = (weights: readonly number[]): void => {
        const columns = weights.map(w => `minmax(4rem, ${w}fr)`).join(" ");
        for (const row of Array.from(element.querySelectorAll<HTMLElement>(".nq-table-row"))) row.style.gridTemplateColumns = columns;
      };
      const widthsOf = (): readonly number[] => {
        const block = ctx.snapshot().blocks[ctx.block];
        const stored = block?.fields.widths;
        const rows = (ctx.snapshot().blocks[ctx.block]?.children ?? []) as readonly string[];
        const widest = Math.max(1, ...rows.map(r => ((ctx.snapshot().blocks[r]?.children ?? []) as readonly string[]).length));
        return Array.isArray(stored) && stored.every(w => typeof w === "number" && w > 0) ? (stored as number[]) : Array.from({ length: widest }, () => 1);
      };
      let dragging: { column: number; weights: number[]; original: number; tableWidth: number } | undefined;
      element.addEventListener("pointerdown", (event) => {
        const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".nq-table-resize") : null;
        if (handle === null) return;
        event.preventDefault();
        const column = Number(handle.dataset.column);
        const weights = [...widthsOf()];
        dragging = { column, weights, original: weights[column] ?? 1, tableWidth: inner.getBoundingClientRect().width };
        handle.setPointerCapture?.(event.pointerId);
      });
      element.addEventListener("pointermove", (event) => {
        if (dragging === undefined) return;
        const deltaWeight = event.movementX / Math.max(1, dragging.tableWidth);
        const { column, weights } = dragging;
        const MIN = 0.15;
        const delta = Math.max(deltaWeight, MIN - weights[column]!);
        const grow = Math.min(delta, weights[column + 1]! - MIN);
        if (grow > 0) { weights[column]! += grow; weights[column + 1]! -= grow; applyWidths(weights); }
      });
      const release = (): void => {
        if (dragging === undefined) return;
        const { column, weights, original } = dragging;
        dragging = undefined;
        void ctx.run("nooq.table.resize-column", { table: ctx.block, column, deltaWeight: weights[column]! - original });
      };
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", () => { if (dragging !== undefined) { applyWidths(widthsOf()); dragging = undefined; } });
      return { element, update() { applyWidths(widthsOf()); } };
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
        const tableId = ctx.parent; // the row's parent IS the table (EB-T: no scan)
        const spanOf = (row: string): number => ((ctx.snapshot().blocks[row]?.children ?? []) as readonly string[])
          .reduce((sum, cell) => sum + (typeof ctx.snapshot().blocks[cell]?.fields.colspan === "number" ? (ctx.snapshot().blocks[cell]!.fields.colspan as number) : 1), 0);
        const widest = tableId === null ? 0 : Math.max(...((view.blocks[tableId]?.children ?? []) as readonly string[]).map(row => spanOf(row)));
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
        // Merged cells (stage 4): the span is a field; the grid consumes N tracks.
        const paintSpan = (span: number): void => { if (span > 1) element.style.gridColumn = `span ${span}`; else element.style.gridColumn = ""; };
        // The resize reporter: a column edge when this cell is not its row's
        // last (the table's own right edge is nobody's handle). data-column
        // names the column it grows; the TABLE view owns the drag.
        const resize = document.createElement("div");
        resize.className = "nq-table-resize";
        resize.setAttribute("role", "separator");
        // Structure without scanning (EB-T): the context carries the tree —
        // ctx.parent IS the row, ctx.parentOf finds the table, O(1) each.
        const rowOfCell = (): string | null => ctx.parent; // typed narrow once, below stays honest
        const columnOfCell = (): number => {
          const row = rowOfCell();
          if (row === null) return -1;
          const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[] }> };
          return (view.blocks[row]?.children as readonly string[] | undefined)?.indexOf(ctx.block) ?? -1;
        };
        const refresh = (): void => {
          const row = rowOfCell();
          if (row === null) { resize.remove(); return; }
          const view = ctx.snapshot() as unknown as { blocks: Record<string, { children: readonly string[] }> };
          const cells = view.blocks[row]?.children as readonly string[] | undefined;
          if (cells === undefined || cells.at(-1) === ctx.block) { resize.remove(); return; }
          resize.dataset.column = String(cells.indexOf(ctx.block));
          if (!body?.contains(resize)) body?.append(resize);
        };
        refresh();

        // Navigation: view-local; only row-creation is a command.
        const position = (): { row: string; rows: readonly string[]; cells: readonly string[]; at: number } | null => {
          const view = ctx.snapshot() as unknown as { roots: readonly string[]; blocks: Record<string, { children: readonly string[]; type: string }> };
          const row = rowOfCell();
          if (row === null) return null;
          const tableId = ctx.parentOf(row);
          if (tableId === undefined || tableId === null) return null;
          const rows = view.blocks[tableId]!.children;
          const cells = view.blocks[row]?.children;
          if (cells === undefined) return null;
          return { row, rows, cells, at: cells.indexOf(ctx.block) };
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
        return { element, update(block) { refresh(); paintSpan(typeof block.fields.colspan === "number" ? block.fields.colspan : 1); }, destroy() { text.destroy(); resize.remove(); } };
      } },
  ],
});
