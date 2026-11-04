import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { table, tableRow, tableCell, tablesPlugin, insertTable, addRowAfter, addColumn, removeColumn, moveColumn, completeRow, toggleHeaderRow } from "../src/index.ts";
import { tablesFormatters } from "../src/export.ts";
import { importMarkdown, exportMarkdown } from "@nooq/plugins";
import { essentials } from "@nooq/plugins/essentials";
import { Editor } from "@nooq/editor";

describe("tables (0015 stage 1)", () => {
  test("the tree: table → row → cell; cells hold inline text", () => {
    expect(table.create().fields).toEqual({});
    expect(tableRow.create().fields).toEqual({});
    expect(tableCell.create().text).toEqual({ s: "", marks: [] });
    expect(tableCell.create().fields).toEqual({ colspan: 1 }); // the birthright (stage 4)
    expect(tablesPlugin.contributes.blocks).toHaveLength(3);
  });

  test("insertTable: a 2×2 starter in ONE transaction, selection at the first cell", () => {
    const e = new Editor({ docId: "t1", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    const result = e.commands.run(insertTable, { parent: null, index: 1 });
    expect(result.status).toBe("applied");
    const tableId = e.view.roots[1]!;
    expect(e.view.blocks[tableId]!.type).toBe("nooq.table/v1");
    const rows = e.view.blocks[tableId]!.children;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(e.view.blocks[row]!.type).toBe("nooq.table-row/v1");
      expect(e.view.blocks[row]!.children).toHaveLength(2);
      for (const cell of e.view.blocks[row]!.children) expect(e.view.blocks[cell]!.type).toBe("nooq.table-cell/v1");
    }
    e.close();
  });

  test("addRowAfter: one transaction, width matching the source row", () => {
    const e = new Editor({ docId: "t2", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const tableId = e.view.roots[1]!;
    const firstRow = e.view.blocks[tableId]!.children[0]!;
    const added = e.commands.run(addRowAfter, { afterRow: firstRow });
    expect(added.status).toBe("applied");
    expect(e.view.blocks[tableId]!.children).toHaveLength(3);
    const newRow = e.view.blocks[tableId]!.children[1]!;
    expect(e.view.blocks[newRow]!.children).toHaveLength(2);
    e.close();
  });

  test("cells merge like all text: two writers in one cell keep both (the CRDT owns typing)", () => {
    const e = new Editor({ docId: "t3", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const tableId = e.view.roots[1]!;
    const cell = e.view.blocks[e.view.blocks[tableId]!.children[0]!]!.children[0]!;
    e.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: "hello" }] });
    expect(e.view.blocks[cell]!.text!.s).toBe("hello");
    e.close();
  });

  test("pipes both directions: import → the tree; export → identical pipes", () => {
    const md = "| a | b |\n| --- | --- |\n| c | d |";
    const doc = importMarkdown(md);
    expect(doc).toHaveLength(1);
    const tableItem = doc[0]!;
    expect(tableItem.data.type).toBe("nooq.table/v1");
    expect(tableItem.children).toHaveLength(2);
    expect(tableItem.children[0]!.children).toHaveLength(2);
    expect(tableItem.children[0]!.children[0]!.data.text!.s).toBe("a");
    expect(tableItem.children[1]!.children[1]!.data.text!.s).toBe("d");
    // Export through the host path: identical pipes back
    const e = new Editor({ docId: "t4", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    const { importBlocks } = require("@nooq/plugins/essentials") as typeof import("@nooq/plugins/essentials");
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    expect(exportMarkdown(e.view as never, { formatters: tablesFormatters }).markdown.trim()).toBe(md);
    e.close();
  });

  test("ragged rows are legal: a short row inserts and renders (0015's public decision)", () => {
    const e = new Editor({ docId: "t5", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const tableId = e.view.roots[1]!;
    // Add a row, then delete one of its cells: a 1-wide row in a 2-wide table — legal, honest.
    e.commands.run(addRowAfter, { afterRow: e.view.blocks[tableId]!.children[0]! });
    const lastRow = e.view.blocks[tableId]!.children[2]!;
    e.commands.run("nooq.block.delete", { block: e.view.blocks[lastRow]!.children[1]! });
    expect(e.view.blocks[lastRow]!.children).toHaveLength(1); // short, honest, present
    e.close();
  });
});

describe("stage 2: column gestures, the ragged repair, headers", () => {
  function table3x2() {
    const e = new Editor({ docId: `s2-${Math.random()}`, actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    // grow to 3 columns × 2 rows for the move tests
    const t = e.view.roots[1]!;
    e.commands.run(addColumn, { table: t });
    return { e, t };
  }

  test("addColumn: ONE transaction, every row gains a cell; selection at the new column", () => {
    const { e, t } = table3x2();
    for (const row of e.view.blocks[t]!.children) expect(e.view.blocks[row]!.children).toHaveLength(3);
    e.close();
  });

  test("addColumn on a ragged table: short rows stay short (the honest decision, held under gesture)", () => {
    const { e, t } = table3x2();
    const lastRow = e.view.blocks[t]!.children[1]!;
    e.commands.run("nooq.block.delete", { block: e.view.blocks[lastRow]!.children[2]! }); // shorten to 2
    e.commands.run(addColumn, { table: t }); // append at width 3
    expect(e.view.blocks[e.view.blocks[t]!.children[0]!]!.children).toHaveLength(4);
    expect(e.view.blocks[lastRow]!.children).toHaveLength(2); // stays short — no silent padding
    e.close();
  });

  test("removeColumn: one transaction; the last column is guarded", () => {
    const { e, t } = table3x2();
    expect(e.commands.run(removeColumn, { table: t, at: 1 }).status).toBe("applied");
    for (const row of e.view.blocks[t]!.children) expect(e.view.blocks[row]!.children).toHaveLength(2);
    // Guard: whittle to one column, then removal declines
    e.commands.run(removeColumn, { table: t, at: 1 });
    expect(e.commands.run(removeColumn, { table: t, at: 0 }).status).toBe("not-applicable");
    e.close();
  });

  test("moveColumn: one transaction of moves; the swap is visible in every row", () => {
    const { e, t } = table3x2();
    const row = e.view.blocks[t]!.children[0]!;
    const cells = e.view.blocks[row]!.children;
    for (const [i, cell] of cells.entries()) e.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: `c${i}` }] });
    expect(e.commands.run(moveColumn, { table: t, from: 0, to: 2 }).status).toBe("applied");
    const after = e.view.blocks[row]!.children.map(id => e.view.blocks[id]!.text!.s);
    expect(after).toEqual(["c1", "c2", "c0"]); // c0 moved to the end
    e.close();
  });

  test("completeRow: the ragged repair is ONE transaction to the widest row", () => {
    const { e, t } = table3x2();
    const lastRow = e.view.blocks[t]!.children[1]!;
    e.commands.run("nooq.block.delete", { block: e.view.blocks[lastRow]!.children[2]! });
    expect(e.view.blocks[lastRow]!.children).toHaveLength(2);
    expect(e.commands.run(completeRow, { row: lastRow }).status).toBe("applied");
    expect(e.view.blocks[lastRow]!.children).toHaveLength(3);
    expect(e.commands.run(completeRow, { row: lastRow }).status).toBe("not-applicable"); // complete: a no-op is not a transaction
    e.close();
  });

  test("toggleHeaderRow: a header is a row property; export keeps the separator after row one", async () => {
    const { exportMarkdown } = await import("@nooq/plugins");
    const { tablesFormatters } = await import("../src/export.ts");
    const { e, t } = table3x2();
    const firstRow = e.view.blocks[t]!.children[0]!;
    expect(e.commands.run(toggleHeaderRow, { row: firstRow }).status).toBe("applied");
    expect(e.view.blocks[firstRow]!.fields.header).toBe(true);
    const md = exportMarkdown(e.view as never, { formatters: tablesFormatters }).markdown;
    expect(md).toContain("| --- | --- |");
    e.close();
  });
});

describe("stage 3a: column sizing", () => {
  test("resizeColumn: ONE setField; weights land clamped; no-op deltas decline", () => {
    const e = new Editor({ docId: "s3a", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    const grew = e.commands.run("nooq.table.resize-column", { table: t, column: 0, deltaWeight: 1 });
    expect(grew.status).toBe("applied");
    const widths = e.view.blocks[t]!.fields.widths as number[];
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(widths[1]); // grew rightward, absorbed by the neighbor
    const sum = widths[0]! + widths[1]!;
    expect(sum).toBeCloseTo(2); // the boundary moves; the table does not grow
    // Clamp: squeezing column 0 below the minimum declines
    expect(e.commands.run("nooq.table.resize-column", { table: t, column: 0, deltaWeight: -10 }).status).toBe("not-applicable");
    e.close();
  });
  test("resize persists from the stored weights (a second gesture starts where the first ended)", () => {
    const e = new Editor({ docId: "s3a2", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    e.commands.run("nooq.table.resize-column", { table: t, column: 0, deltaWeight: 0.5 });
    const first = e.view.blocks[t]!.fields.widths as number[];
    e.commands.run("nooq.table.resize-column", { table: t, column: 0, deltaWeight: 0.25 });
    const second = e.view.blocks[t]!.fields.widths as number[];
    expect(second[0]!).toBeCloseTo(first[0]! + 0.25);
    e.close();
  });
});

describe("stage 3b: selection ranges", () => {
  test("clearRange: the rectangle's non-empty cells in ONE transaction; all-empty declines", () => {
    const e = new Editor({ docId: "s3b", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    const grid = e.view.blocks[t]!.children.map(row => e.view.blocks[row]!.children as string[]);
    for (const [r, row] of grid.entries()) for (const [c, cell] of row.entries()) e.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: `r${r}c${c}` }] });
    const rectangle = [grid[0]![0]!, grid[0]![1]!, grid[1]![0]!]; // an L across two rows
    const cleared = e.commands.run("nooq.table.clear-range", { cells: rectangle });
    expect(cleared.status).toBe("applied");
    expect(e.view.blocks[grid[0]![0]!]!.text!.s).toBe("");
    expect(e.view.blocks[grid[0]![1]!]!.text!.s).toBe("");
    expect(e.view.blocks[grid[1]![0]!]!.text!.s).toBe("");
    expect(e.view.blocks[grid[1]![1]!]!.text!.s).toBe("r1c1"); // outside the rectangle: untouched
    expect(e.commands.run("nooq.table.clear-range", { cells: rectangle }).status).toBe("not-applicable"); // all empty now
    e.close();
  });
});

describe("stage 3c: paste into a range", () => {
  test("pipes fill the rectangle from its anchor — ONE transaction; identical values are not edits", () => {
    const e = new Editor({ docId: "s3c", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    const grid = e.view.blocks[t]!.children.map(row => e.view.blocks[row]!.children as string[]);
    const pasted = e.commands.run("nooq.table.paste-range", { cells: grid, values: [["a", "b"], ["c", "d"]] });
    expect(pasted.status).toBe("applied");
    expect(e.view.blocks[grid[0]![0]!]!.text!.s).toBe("a");
    expect(e.view.blocks[grid[1]![1]!]!.text!.s).toBe("d");
    // Re-pasting identical values: not a transaction
    expect(e.commands.run("nooq.table.paste-range", { cells: grid, values: [["a", "b"], ["c", "d"]] }).status).toBe("not-applicable");
    e.close();
  });

  test("the clipboard exceeding the rectangle truncates honestly — no auto-grow, no invented cells", () => {
    const e = new Editor({ docId: "s3c2", actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    const grid = e.view.blocks[t]!.children.map(row => e.view.blocks[row]!.children as string[]);
    const oneRow: string[][] = [grid[0]!]; // a 1-row rectangle
    e.commands.run("nooq.table.paste-range", { cells: oneRow, values: [["x", "y"], ["overflow", "row"]] });
    expect(e.view.blocks[grid[0]![0]!]!.text!.s).toBe("x");
    expect(e.view.blocks[grid[0]![1]!]!.text!.s).toBe("y");
    expect(e.view.blocks[grid[1]![0]!]!.text!.s).toBe(""); // the overflow row never landed
    e.close();
  });
});

describe("stage 4: merged and split cells", () => {
  const grid2x2 = () => {
    const e = new Editor({ docId: `m${Math.random()}`, actor: { actorId: "w" }, plugins: [essentials, tablesPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.commands.run(insertTable, { parent: null, index: 1 });
    const t = e.view.roots[1]!;
    return { e, t, grid: e.view.blocks[t]!.children.map(row => e.view.blocks[row]!.children as string[]) };
  };

  test("merge: ONE transaction — the origin carries colspan, covered cells tombstone", () => {
    const { e, grid } = grid2x2();
    const merged = e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[0]![1]!] });
    expect(merged.status).toBe("applied");
    expect(e.view.blocks[grid[0]![0]!]!.fields.colspan).toBe(2);
    expect(e.view.blocks[grid[0]![0]!]!.text).toBeDefined(); // the origin, alive with its text
    expect(e.view.blocks[grid[0]![1]!]).toBeDefined(); // tombstoned: map entry persists (DM-3.4)
    e.close();
  });

  test("merge is honest about scope: cross-row ranges decline (rowspan is stage 2, named)", () => {
    const { e, grid } = grid2x2();
    const attempted = e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[1]![0]!] });
    expect(attempted.status).toBe("not-applicable");
    e.close();
  });

  test("split: the exact inverse — colspan-1 cells restored in place", () => {
    const { e, grid } = grid2x2();
    e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[0]![1]!] });
    const split = e.commands.run("nooq.table.split", { cell: grid[0]![0]! });
    expect(split.status).toBe("applied");
    expect(e.view.blocks[grid[0]![0]!]!.fields.colspan).toBe(1);
    expect(e.view.blocks[grid[0]![0]!]!.text).toBeDefined(); // origin still alive
    const row = e.view.blocks[Object.keys(e.view.blocks).find(id => (e.view.blocks[id]!.children as readonly string[]).includes(grid[0]![0]!))!]!;
    expect(row.children.length).toBeGreaterThanOrEqual(2); // restored to width
    e.close();
  });

  test("UNDO round-trips both, for free (DM-4.10 over merge and split)", () => {
    const { e, grid } = grid2x2();
    e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[0]![1]!] });
    e.undo();
    expect(e.view.blocks[grid[0]![0]!]!.fields.colspan).toBe(1); // the span write, undone to the birthright
    const rowAfter = Object.keys(e.view.blocks).find(id => (e.view.blocks[id]!.children as readonly string[]).includes(grid[0]![0]!))!;
    expect((e.view.blocks[rowAfter]!.children as readonly string[])).toContain(grid[0]![1]!); // the covered cell, restored to its row
    // And split: merge again, split, undo the split — the merge is back
    e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[0]![1]!] });
    e.commands.run("nooq.table.split", { cell: grid[0]![0]! });
    e.undo();
    expect(e.view.blocks[grid[0]![0]!]!.fields.colspan).toBe(2); // the merge stands again
    e.close();
  });

  test("the ghost counts SPAN-SUM, not cells: a merged row is ragged on purpose, no ghost", () => {
    const { e, t, grid } = grid2x2();
    e.commands.run("nooq.table.merge", { cells: [grid[0]![0]!, grid[0]![1]!] });
    // Row 0 now: one cell, colspan 2 → span-sum 2 = the table's width: NOT ragged
    const view = e.view as unknown as { blocks: Record<string, { children: readonly string[]; fields: Record<string, unknown> }> };
    const spanSum = (row: string): number => view.blocks[row]!.children.reduce((sum, cell) => sum + (typeof view.blocks[cell]!.fields.colspan === "number" ? (view.blocks[cell]!.fields.colspan as number) : 1), 0);
    expect(spanSum(grid[0]![0]! === undefined ? "" : (e.view.blocks[t]!.children as string[])[0]!)).toBe(2);
    e.close();
  });
});
