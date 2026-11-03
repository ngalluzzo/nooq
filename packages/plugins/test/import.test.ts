import { describe, expect, test } from "bun:test";
import { importMarkdown } from "../src/import.ts";
import { exportMarkdown } from "../src/export.ts";
import { essentials, importBlocks } from "../src/essentials.ts";
import { Editor } from "../../editor/src/controller.ts";

const stateOf = (blocks: ReturnType<typeof importMarkdown>) => blocks; // tree, for direct assertions

describe("markdown import (Tier-2, the export's inverse)", () => {
  test("the reference dialect: every block shape", () => {
    const doc = importMarkdown([
      "# Title here",
      "## Section",
      "",
      "A paragraph with **bold**, *em*, `code`, and a [link](https://nooq.dev).",
      "",
      "- bullet one",
      "- bullet two",
      "  - nested bullet",
      "1. numbered",
      "- [ ] open task",
      "- [x] done task",
      "> a quote",
      "---",
      "Plain last line",
    ].join("\n"));
    const types = doc.map(node => node.data.type);
    expect(types).toEqual([
      "nooq.heading/v1", "nooq.heading/v1", "nooq.paragraph/v1",
      "nooq.list/v1", "nooq.list/v1",
      "nooq.list/v1", "nooq.list/v1", "nooq.list/v1",
      "nooq.quote/v1", "nooq.divider/v1", "nooq.paragraph/v1",
    ]);
    expect(doc[0]!.data.fields.level).toBe(1);
    expect(doc[1]!.data.fields.level).toBe(2);
    // Nesting: bullet two carries the nested bullet as a child
    expect(doc[4]!.children).toHaveLength(1);
    expect(doc[4]!.children[0]!.data.fields.kind).toBe("bullet");
    // List kinds
    expect(doc[3]!.data.fields.kind).toBe("bullet");
    expect(doc[5]!.data.fields.kind).toBe("number");
    expect(doc[6]!.data.fields.checked).toBeUndefined();
    expect(doc[7]!.data.fields.checked).toBe(true);
    // Inline marks
    const p = doc[2]!.data.text!;
    expect(p.s).toBe("A paragraph with bold, em, code, and a link.");
    expect(p.marks[17]).toEqual(["strong"]);   // "bold"
    expect(p.marks[23]).toEqual(["em"]);       // "em"
    expect(p.marks[27]).toEqual(["code"]);     // "code"
    const linkToken = p.marks[39]![0]!; expect(linkToken.startsWith("link:")).toBeTrue();
    expect(linkToken.startsWith("link:")).toBeTrue();
    expect(doc[2]!.data.fields[linkToken]).toBe("https://nooq.dev");
    void stateOf;
  });

  test("THE ROUND TRIP: import and export are mutual inverses (a fixpoint)", () => {
    const handwritten = [
      "# One",
      "## Two",
      "Plain **strong** text.",
      "- a",
      "- b",
      "  - b.child",
      "1. first",
      "- [ ] open",
      "- [x] shut",
      "> quoted words",
      "---",
      "Tail",
    ].join("\n");
    // One normalization pass lands in the exported dialect (blank-line joins);
    // from there, export ∘ import is the identity — the fixpoint property.
    const canonical = exportMarkdownFromTree(importMarkdown(handwritten));
    const again = exportMarkdownFromTree(importMarkdown(canonical));
    expect(again).toBe(canonical);
    // And the canonical form actually contains everything we wrote
    expect(canonical).toContain("# One");
    expect(canonical).toContain("  - b.child");
    expect(canonical).toContain("- [x] shut");
    expect(canonical).toContain("> quoted words");
    expect(canonical).toContain("**strong**");
  });

  test("unknown syntax degrades to paragraphs — visible, never dropped", () => {
    const doc = importMarkdown("definitely | not || markdown ~~strike~~");
    expect(doc).toHaveLength(1);
    expect(doc[0]!.data.type).toBe("nooq.paragraph/v1");
    expect(doc[0]!.data.text!.s).toContain("not");
  });

  test("the command: a whole tree lands in ONE transaction, nested ids resolve", () => {
    const e = new Editor({ docId: "paste", actor: { actorId: "w" }, plugins: [essentials] });
    const anchor = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    const tree = importMarkdown("- outer\n  - inner");
    const result = e.commands.run(importBlocks, { blocks: tree, after: anchor });
    expect(result.status).toBe("applied");
    const outer = e.view.roots[1]!;
    expect(e.view.blocks[outer]!.type).toBe("nooq.list/v1");
    const inner = e.view.blocks[outer]!.children[0]!;
    expect(e.view.blocks[inner]!.fields.kind).toBe("bullet");
    // The anchor is untouched; the tree follows it, roots in order
    expect(e.view.roots).toEqual([anchor, outer]);
    e.close();
  });
});

/** Export a tree by planting it through an editor (the same export path hosts use). */
function exportMarkdownFromTree(tree: ReturnType<typeof importMarkdown>): string {
  const e = new Editor({ docId: "rt", actor: { actorId: "w" }, plugins: [essentials] });
  e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
  const after = e.view.roots[0]!;
  e.commands.run(importBlocks, { blocks: tree, after });
  // Remove the seed so the export is exactly the imported document
  e.commands.run("nooq.block.delete", { block: after });
  return exportMarkdown(e.view as never).markdown.trim();
}
