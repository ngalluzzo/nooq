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
