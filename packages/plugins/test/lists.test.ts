import { describe, expect, test } from "bun:test";
import { essentials, listItem, splitBlock, toggleCheck, insertBlock, paragraph } from "../src/essentials.ts";
import { exportMarkdown } from "../src/export.ts";
import { Editor } from "../../editor/src/controller.ts";

/** Tier-1 lists: the block, split semantics, checkbox, export — through commands. */
describe("list items (Tier-1)", () => {
  function editor() {
    const e = new Editor({ docId: "lists", actor: { actorId: "w" }, plugins: [essentials] });
    return e;
  }

  test("the block exists with three kinds by field; create defaults to bullet", () => {
    expect(listItem.type).toBe("nooq.list/v1");
    expect(listItem.create().fields).toEqual({ kind: "bullet" });
    expect(listItem.create().text).toEqual({ s: "", marks: [] });
  });

  test("Enter continues the list: split begets a same-kind item", async () => {
    const e = editor();
    const item = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "first", fields: { kind: "number" } });
    const id = item;
    // Caret at end, split
    const result = e.commands.run(splitBlock, { block: id, anchor: 5, head: 5 }, { selection: { block: id, anchor: 5, head: 5 } });
    expect(result.status).toBe("applied");
    const view = e.view;
    const siblings = view.roots;
    expect(siblings).toHaveLength(2);
    expect(view.blocks[siblings[1]!]!.type).toBe("nooq.list/v1");
    expect(view.blocks[siblings[1]!]!.fields.kind).toBe("number");
    e.close();
  });

  test("Enter in an EMPTY list item exits to a paragraph", () => {
    const e = editor();
    const item = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "", fields: { kind: "bullet" } });
    const id = item;
    const result = e.commands.run(splitBlock, { block: id, anchor: 0, head: 0 }, { selection: { block: id, anchor: 0, head: 0 } });
    expect(result.status).toBe("applied");
    expect(e.view.roots).toHaveLength(1);
    expect(e.view.blocks[e.view.roots[0]!]!.type).toBe("nooq.paragraph/v1");
    e.close();
  });

  test("Enter in a heading continues the heading (same-type split generalizes)", () => {
    const e = editor();
    const id = e.insertBlock({ type: "nooq.heading/v1", parent: null, text: "Title text" });
    e.commands.run(splitBlock, { block: id, anchor: 5, head: 5 }, { selection: { block: id, anchor: 5, head: 5 } });
    const roots = e.view.roots;
    expect(roots).toHaveLength(2);
    expect(e.view.blocks[roots[1]!]!.type).toBe("nooq.heading/v1");
    e.close();
  });

  test("the checkbox is one field write through the command (§1)", () => {
    const e = editor();
    const item = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "task", fields: { kind: "check" } });
    const id = item;
    expect(e.view.blocks[id]!.fields.checked).toBeUndefined();
    e.commands.run(toggleCheck, { block: id });
    expect(e.view.blocks[id]!.fields.checked).toBe(true);
    e.commands.run(toggleCheck, { block: id });
    expect(e.view.blocks[id]!.fields.checked).toBe(false);
    // Not applicable outside check items
    const p = e.insertBlock({ type: paragraph.type, parent: null, text: "plain" });
    expect(e.commands.run(toggleCheck, { block: p }).status).toBe("not-applicable");
    e.close();
  });

  test("list items nest through children (no list-specific model rules)", () => {
    const e = editor();
    const parent = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "outer", fields: { kind: "bullet" } });
    const pid = parent;
    e.insertBlock({ type: "nooq.list/v1", parent: pid, text: "inner", fields: { kind: "bullet" } });
    expect(e.view.blocks[pid]!.children).toHaveLength(1);
    e.close();
  });

  test("export: bullet, numbered, checked and unchecked to-do, nesting", () => {
    const e = editor();
    e.insertBlock({ type: "nooq.list/v1", parent: null, text: "bullet item", fields: { kind: "bullet" } });
    e.insertBlock({ type: "nooq.list/v1", parent: null, text: "numbered item", fields: { kind: "number" } });
    e.insertBlock({ type: "nooq.list/v1", parent: null, text: "open task", fields: { kind: "check" } });
    e.insertBlock({ type: "nooq.list/v1", parent: null, text: "done task", fields: { kind: "check", checked: true } });
    e.insertBlock({ type: "nooq.list/v1", parent: e.view.roots[0], text: "nested item", fields: { kind: "bullet" } });
    const md = exportMarkdown(e.view as never).markdown;
    expect(md).toContain("- bullet item");
    expect(md).toContain("1. numbered item");
    expect(md).toContain("- [ ] open task");
    expect(md).toContain("- [x] done task");
    expect(md).toContain("- nested item");
    e.close();
  });

  test("Backspace at the seam joins list items (same-type textMerge)", () => {
    const e = editor();
    const a = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "first ", fields: { kind: "bullet" } });
    void a;
    e.insertBlock({ type: "nooq.list/v1", parent: null, text: "second", fields: { kind: "bullet" } });
    const one = e.view.roots[0]!, two = e.view.roots[1]!;
    // merge takes a document range (anchor in the first, head in the last)
    const merged = e.commands.run("nooq.text.merge", { range: { anchor: { block: one, offset: 6 }, head: { block: two, offset: 0 } }, text: "" }, { selection: { block: two, anchor: 0, head: 0 } });
    expect(merged.status).toBe("applied");
    expect(e.view.roots).toHaveLength(1);
    expect(e.view.blocks[e.view.roots[0]!]!.text?.s).toBe("first second");
    e.close();
  });
});

describe("heading levels + divider (Tier-1)", () => {
  function editor() {
    return new Editor({ docId: "levels", actor: { actorId: "w" }, plugins: [essentials] });
  }

  test("heading defaults to level 2; slash-insert at any level; split preserves it", () => {
    const e = editor();
    const h2 = e.insertBlock({ type: "nooq.heading/v1", parent: null, text: "default" });
    expect(e.view.blocks[h2]!.fields.level).toBe(2);
    const h1 = e.insertBlock({ type: "nooq.heading/v1", parent: null, text: "top", fields: { level: 1 } });
    expect(e.view.blocks[h1]!.fields.level).toBe(1);
    // Split carries the level (same-type split from the lists work)
    e.commands.run(splitBlock, { block: h1, anchor: 3, head: 3 }, { selection: { block: h1, anchor: 3, head: 3 } });
    expect(e.view.blocks[e.view.roots[2]!]!.fields.level).toBe(1);
    e.close();
  });

  test("export: level hashes match", () => {
    const e = editor();
    e.insertBlock({ type: "nooq.heading/v1", parent: null, text: "one", fields: { level: 1 } });
    e.insertBlock({ type: "nooq.heading/v1", parent: null, text: "three", fields: { level: 3 } });
    const md = exportMarkdown(e.view as never).markdown;
    expect(md).toContain("# one");
    expect(md).toContain("### three");
    e.close();
  });

  test("divider: textless block, markdown ---", () => {
    const e = editor();
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "above" });
    e.insertBlock({ type: "nooq.divider/v1", parent: null });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "below" });
    const md = exportMarkdown(e.view as never).markdown;
    expect(md).toContain("above");
    expect(md).toContain("---");
    expect(md).toContain("below");
    e.close();
  });
});
