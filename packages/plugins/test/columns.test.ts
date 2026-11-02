/**
 * Multi-column layout blocks (foundation P2): the schema pair, the
 * one-transaction insert command (five blocks, one intent, slash consumed,
 * selection in column 1's paragraph), its decline paths, concurrent merges
 * into different columns of one columns block over a real relay, and the DOM
 * nesting through a real surface. Reading order is the rule throughout:
 * tree order = column order = DOM order (foundation.md).
 */
import "../../editor/test/dom.ts";
import { expect, test } from "bun:test";
import { canonicalJson, makeBlock } from "@nooq/core";
import { column, columns, essentials, insertColumns, paragraph } from "../src/essentials.ts";
import type { BlockDefinition } from "../src/index.ts";
import { exportMarkdown } from "../src/export.ts";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { NooqRelay, settled } from "../../sync/src/index.ts";

/** An editor with the essentials plugin and one paragraph holding a bare slash. */
function slashedEditor(docId: string): { editor: Editor; seed: string } {
  const editor = new Editor({ docId, actor: { actorId: "writer" }, plugins: [essentials] });
  const seed = editor.insertBlock({ type: paragraph.type, parent: null });
  editor.editText(seed, "/");
  return { editor, seed };
}

/** Reads the seeded shape back out of the view: [columns, left, leftText, right, rightText]. */
function seededShape(editor: Editor, columnsId: string): [string, string, string, string, string] {
  const [left, right] = editor.view.blocks[columnsId]!.children;
  const leftText = editor.view.blocks[left!]!.children[0]!, rightText = editor.view.blocks[right!]!.children[0]!;
  return [columnsId, left!, right!, leftText, rightText];
}

test("the layout schemas carry no fields and no text, create fresh, and diagnose clean", () => {
  expect(essentials.contributes.blocks.map(block => block.type)).toContain(columns.type);
  expect(essentials.contributes.blocks.map(block => block.type)).toContain(column.type);
  for (const block of [columns, column]) {
    expect(block.text).toBe("none");
    expect(block.create()).toEqual({ fields: {} });
    expect("text" in block.create()).toBe(false); // never seeds inline content
    const definition: BlockDefinition = block; // the contract every consumer resolves
    expect(definition.diagnose(makeBlock({ type: block.type, fields: {} }, "writer"))).toEqual([]);
  }
});

test("insert columns is one transaction: five blocks, wired parents and indexes, slash consumed, selection in column 1's paragraph", () => {
  const { editor, seed } = slashedEditor("columns-insert");
  const blocksBefore = Object.keys(editor.view.blocks).length;
  const history = editor.history().length;
  const result = editor.commands.run(insertColumns, { parent: null, index: 1, clearBlock: seed });
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error(result.status);

  // Exactly one transaction, one intent, six ops in parent-before-child order.
  expect(editor.history()).toHaveLength(history + 1);
  const tx = editor.history().at(-1)!;
  expect(tx.intent).toBe("insert-columns");
  expect(tx.ops.map(op => op.op)).toEqual(["textEdit", "insert", "insert", "insert", "insert", "insert"]);
  const inserts = tx.ops.filter(op => op.op === "insert");
  expect(inserts).toHaveLength(5);
  expect(Object.keys(editor.view.blocks)).toHaveLength(blocksBefore + 5);

  // The tree shape: columns → [column → [paragraph], column → [paragraph]].
  const columnsId = editor.view.roots[1]!;
  expect(editor.view.roots).toEqual([seed, columnsId]);
  const [, left, right, leftText, rightText] = seededShape(editor, columnsId);
  expect(editor.view.blocks[columnsId]!.type).toBe(columns.type);
  expect(editor.view.blocks[columnsId]!.children).toEqual([left, right]);
  expect(editor.view.blocks[left]!.type).toBe(column.type);
  expect(editor.view.blocks[left]!.children).toEqual([leftText]);
  expect(editor.view.blocks[right]!.type).toBe(column.type);
  expect(editor.view.blocks[right]!.children).toEqual([rightText]);
  expect(editor.view.blocks[leftText]!.type).toBe(paragraph.type);
  expect(editor.view.blocks[leftText]!.text).toEqual({ s: "", marks: [] });
  expect(editor.view.blocks[rightText]!.type).toBe(paragraph.type);
  // Wired indexes: columns after the slash block; columns' children 0 and 1; paragraphs first inside.
  expect(inserts.map(op => op.op === "insert" ? [op.parent, op.index] : null)).toEqual([
    [null, 1], [columnsId, 0], [left, 0], [columnsId, 1], [right, 0],
  ]);

  // The slash is consumed exactly; the source block stays.
  expect(editor.view.blocks[seed]!.text!.s).toBe("");
  // The prepared selection lands in column 1's paragraph, ready to type.
  expect(result.selection).toEqual({ block: leftText, anchor: 0, head: 0 });
  editor.close();
});

test("each preparation mints fresh block ids and never mutates the document", () => {
  const { editor, seed } = slashedEditor("columns-fresh");
  const args = { parent: null, index: 1, clearBlock: seed };
  const first = editor.commands.preview(insertColumns, args), second = editor.commands.preview(insertColumns, args);
  expect(first.status).toBe("ready"); expect(second.status).toBe("ready");
  if (first.status !== "ready" || second.status !== "ready") throw new Error("Expected ready");
  const ids = (prepared: typeof first) => prepared.ops.flatMap(op => op.op === "insert" ? [op.block.id] : []);
  expect(new Set([...ids(first), ...ids(second)]).size).toBe(10); // fresh-ID discipline: no id shared
  expect(editor.view.blocks[seed]!.text!.s).toBe("/"); // preview commits nothing
  editor.close();
});

test("insert columns declines dead parents, stale indexes, dead or changed slash blocks, and rejects invalid args", () => {
  const { editor, seed } = slashedEditor("columns-decline");
  expect(editor.commands.run(insertColumns, { parent: "gone" }).status).toBe("not-applicable");
  expect(editor.commands.run(insertColumns, { parent: null, index: 5 }).status).toBe("not-applicable");
  expect(editor.commands.run(insertColumns, { parent: null, clearBlock: "gone" }).status).toBe("not-applicable");
  // A menu may stay open while remote text arrives: only a bare "/" is consumable.
  editor.editText(seed, "/changed remotely");
  expect(editor.commands.run(insertColumns, { parent: null, index: 1, clearBlock: seed }).status).toBe("not-applicable");
  expect(editor.view.blocks[seed]!.text!.s).toBe("/changed remotely"); // decline changes nothing
  editor.deleteBlock(seed);
  expect(editor.commands.run(insertColumns, { parent: null, clearBlock: seed }).status).toBe("not-applicable"); // dead block
  for (const index of [-1, 1.5, Infinity]) expect(editor.commands.run(insertColumns, { parent: null, index }).status).toBe("failed"); // wrong shape
  editor.close();
});

test("two editors over a real relay: concurrent writes into different columns of one columns block both survive", async () => {
  const relay = new NooqRelay();
  const docId = "columns-merge";
  const alice = new Editor({ docId, actor: { actorId: "human:alice" }, plugins: [essentials], transport: relay.connect(docId) });
  const bob = new Editor({ docId, actor: { actorId: "human:bob" }, plugins: [essentials], transport: relay.connect(docId) });
  await settled();
  const seed = alice.insertBlock({ type: paragraph.type, parent: null });
  alice.editText(seed, "/");
  expect(alice.commands.run(insertColumns, { parent: null, index: 1, clearBlock: seed }).status).toBe("applied");
  await settled(); // bob receives the columns block before either writes
  const columnsId = alice.view.roots[1]!;
  const [, left, right, leftText, rightText] = seededShape(alice, columnsId);
  expect(bob.view.blocks[columnsId]!.children).toEqual([left, right]);

  // Concurrent: each editor writes into a different column before seeing the other's edit.
  alice.editText(leftText, "left by alice");
  bob.editText(rightText, "right by bob");
  await settled();

  for (const editor of [alice, bob]) {
    expect(editor.view.blocks[leftText]!.text!.s).toBe("left by alice");
    expect(editor.view.blocks[rightText]!.text!.s).toBe("right by bob");
    expect(editor.view.blocks[columnsId]!.children).toEqual([left, right]);
    expect(editor.view.blocks[left]!.children).toEqual([leftText]);
    expect(editor.view.blocks[right]!.children).toEqual([rightText]);
  }
  expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
  // The export reads the merged shape in tree order: left column then right.
  expect(exportMarkdown(alice.view).markdown).toBe("left by alice\n\nright by bob");
  alice.close(); bob.close();
});

test("through a real surface the DOM nests columns → column → paragraph with the layout classes and children retained", async () => {
  const { editor, seed } = slashedEditor("columns-views");
  expect(editor.commands.run(insertColumns, { parent: null, index: 1, clearBlock: seed }).status).toBe("applied");
  const columnsId = editor.view.roots[1]!;
  const [, left, right, leftText, rightText] = seededShape(editor, columnsId);
  editor.editText(leftText, "first column");
  editor.editText(rightText, "second column");
  const surface = createSurface(editor, { plugins: [essentialsDOM] });
  document.body.append(surface.element);
  await settled();

  const columnsRow = surface.element.querySelector(`[data-nq-block="${columnsId}"]`)!;
  expect(columnsRow).not.toBeNull();
  const view = columnsRow.querySelector(":scope > .nq-columns"); // the view element directly in the shell
  expect(view).not.toBeNull();
  const grid = columnsRow.querySelector(":scope > .nq-columns > .nq-children")!;
  expect(grid).not.toBeNull();
  // Tree order = DOM order: the grid holds the two column shells, left first.
  const order = Array.from(grid.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.nqBlock !== undefined)
    .map(child => child.dataset.nqBlock);
  expect(order).toEqual([left, right]);
  // Each column shell carries the column view; children stay nested inside it.
  for (const id of [left, right]) {
    const shell = grid.querySelector(`[data-nq-block="${id}"]`)!;
    expect(shell.querySelector(":scope > .nq-column")).not.toBeNull();
    expect(shell.querySelector(`:scope > .nq-column > .nq-children`)).not.toBeNull();
  }
  // The seeded paragraphs render as ordinary paragraph views, in tree order
  // (plain hosts carry their text in .value, so DOM order is the order of hosts).
  const areas = Array.from(grid.querySelectorAll("textarea.nq-input")) as HTMLTextAreaElement[];
  expect(areas).toHaveLength(2);
  expect(areas.map(area => area.value)).toEqual(["first column", "second column"]);
  expect(areas[0]!.compareDocumentPosition(areas[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  surface.destroy();
  editor.close();
});

test("the slash menu offers Two columns; one click builds the five-block shape and focuses column 1", async () => {
  const { editor, seed } = slashedEditor("columns-menu");
  const surface = createSurface(editor, { plugins: [essentialsDOM] });
  document.body.append(surface.element);
  await settled();
  const text = surface.element.querySelector<HTMLTextAreaElement>(`[data-nq-block="${seed}"] textarea`)!;
  text.focus();
  text.value = "/";
  text.dispatchEvent(new Event("input"));
  const before = editor.history().length;
  const item = Array.from(surface.element.querySelectorAll<HTMLElement>("[role=option]"))
    .find(option => option.getAttribute("data-nq-action") === "insert:nooq.columns/v1")!;
  expect(item).toBeDefined();
  expect(item.textContent).toContain("Two columns");
  item.click();
  await settled();
  expect(editor.history()).toHaveLength(before + 1); // one click, one transaction
  const columnsId = editor.view.roots[1]!;
  const [, , , leftText] = seededShape(editor, columnsId);
  expect(editor.view.blocks[seed]!.text!.s).toBe(""); // the slash was consumed
  const focused = document.activeElement as HTMLTextAreaElement;
  expect(focused.closest(`[data-nq-block="${leftText}"]`)).not.toBeNull(); // the caret landed in column 1's paragraph
  surface.destroy();
  editor.close();
});
