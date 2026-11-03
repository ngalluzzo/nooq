import { describe, expect, test } from "bun:test";
import { importMarkdown, exportMarkdown } from "../src/index.ts";
import { essentials } from "../src/essentials.ts";
import { Editor } from "../../editor/src/controller.ts";

describe("richer formatting + alignment", () => {
  test("the new marks round-trip: strike (GFM), underline and highlight (inline HTML)", () => {
    const original = "~~gone~~ stays, <u>important</u> too, and <mark>look here</mark>.";
    const doc = importMarkdown(original);
    const first = doc[0]!.data.text!;
    expect(first.s).toBe("gone stays, important too, and look here.");
    expect(first.marks[0]).toEqual(["strike"]);
    expect(first.marks[12]).toEqual(["underline"]);
    expect(first.marks[33]).toEqual(["highlight"]);
    // Export through the host path: identical
    const e = new Editor({ docId: "rf", actor: { actorId: "w" }, plugins: [essentials] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    const { importBlocks } = require("../src/essentials.ts") as typeof import("../src/essentials.ts");
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    expect(exportMarkdown(e.view as never).markdown.trim()).toBe(original);
    e.close();
  });

  test("the marks stack when adjacent; nesting parses the outer (one-pass parser, stated)", () => {
    const doc = importMarkdown("**bold** and ~~gone~~");
    const text = doc[0]!.data.text!;
    expect(text.marks[0]).toEqual(["strong"]); // adjacent runs, both marked
    expect(text.marks[10]).toEqual(["strike"]);
    // Nested inline (**~~x~~**) parses the outer with the inner glyphs
    // literal — one pass, no re-entry; stated, not hidden.
    const nested = importMarkdown("**~~both~~**");
    expect(nested[0]!.data.text!.s).toBe("~~both~~");
  });

  test("alignment is a field: set, render-input, and back (left is the floor)", () => {
    const e = new Editor({ docId: "al", actor: { actorId: "w" }, plugins: [essentials] });
    const id = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "centered" });
    expect(e.view.blocks[id]!.fields.align).toBeUndefined(); // absent = left, the default
    e.commands.run("nooq.field.set", { block: id, key: "align", value: "center" });
    e.commands.run("nooq.field.set", { block: id, key: "align", value: "right" });
    expect(e.view.blocks[id]!.fields.align).toBe("right");
    // One write, one undo (DM-4.10): the old value returns. (A FIRST set
    // cannot un-set — fields carry values, DM-4.10's stated limit — so the
    // test writes twice: undo returns "center", not absence.)
    e.undo();
    expect(e.view.blocks[id]!.fields.align).toBe("center");
    e.close();
  });

  test("markdown carries no alignment: export keeps text, alignment stays in the field", () => {
    const e = new Editor({ docId: "alx", actor: { actorId: "w" }, plugins: [essentials] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "words", fields: { align: "right" } });
    expect(exportMarkdown(e.view as never).markdown).toContain("words");
    expect(exportMarkdown(e.view as never).markdown).not.toContain("right"); // honest: markdown has no alignment
    e.close();
  });
});
