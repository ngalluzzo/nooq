import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { math, mathPlugin } from "../src/index.ts";
import { mathFormatters } from "../src/export.ts";
import { importMarkdown, exportMarkdown } from "@nooq/plugins";
import { essentials, importBlocks } from "@nooq/plugins/essentials";
import { Editor } from "@nooq/editor";
import katex from "katex";

describe("math blocks (§7 showcase)", () => {
  test("the block: LaTeX as the model's own text, no fields to invent", () => {
    expect(math.type).toBe("nooq.math/v1");
    expect(math.create().text).toEqual({ s: "", marks: [] });
    expect(mathPlugin.contributes.blocks).toHaveLength(1);
  });

  test("KaTeX renders real LaTeX to real markup (the render limb)", () => {
    const host = document.createElement("div");
    katex.render("\\frac{a}{b}", host, { displayMode: true, throwOnError: true });
    expect(host.innerHTML).toContain("mord"); // KaTeX's own class vocabulary
  });

  test("export: $$ fence, source verbatim", () => {
    const block = { id: "m", type: "nooq.math/v1", fields: {}, text: { s: "e^{i\\pi}+1=0", marks: [] }, children: [] } as never;
    expect(mathFormatters["nooq.math/v1"]!(block as never, { text: () => "e^{i\\pi}+1=0", children: "" } as never)).toBe("$$\ne^{i\\pi}+1=0\n$$");
  });

  test("import: $$ regions become math blocks, LaTeX verbatim; round trip identical", () => {
    const doc = importMarkdown("$$\n\\int_0^1 x dx\n$$\n\nAfter");
    expect(doc).toHaveLength(2);
    expect(doc[0]!.data.type).toBe("nooq.math/v1");
    expect(doc[0]!.data.text!.s).toBe("\\int_0^1 x dx");
    expect(doc[1]!.data.type).toBe("nooq.paragraph/v1");
    // The full round trip through the host path
    const e = new Editor({ docId: "math-rt", actor: { actorId: "w" }, plugins: [essentials, mathPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    expect(exportMarkdown(e.view as never, { formatters: mathFormatters }).markdown.trim()).toBe("$$\n\\int_0^1 x dx\n$$\n\nAfter");
    e.close();
  });
});
