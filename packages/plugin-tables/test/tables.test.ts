import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { table, tableRow, tableCell, tablesPlugin, insertTable, addRowAfter } from "../src/index.ts";
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
