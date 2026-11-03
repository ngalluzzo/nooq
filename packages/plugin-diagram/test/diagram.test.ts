import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { diagram, diagramPlugin } from "../src/index.ts";
import { diagramFormatters } from "../src/export.ts";
import { importMarkdown, exportMarkdown } from "@nooq/plugins";
import { essentials, importBlocks } from "@nooq/plugins/essentials";
import { Editor } from "@nooq/editor";
import { render as peleRender } from "pele";

describe("diagram blocks (the sixth §7 path)", () => {
  test("the block: Mermaid source as the model's own text", () => {
    expect(diagram.type).toBe("nooq.diagram/v1");
    expect(diagram.create().text).toEqual({ s: "", marks: [] });
    expect(diagramPlugin.contributes.blocks).toHaveLength(1);
  });

  test("pele renders real Mermaid to SVG (the render limb)", () => {
    const { svg } = peleRender("flowchart LR\n  A --> B");
    expect(svg).toContain("<svg");
    expect(svg).toContain("A");
  });

  test("export: ```mermaid fence, source verbatim", () => {
    const block = { id: "d", type: "nooq.diagram/v1", fields: {}, text: { s: "flowchart LR\n  X --> Y", marks: [] }, children: [] } as never;
    expect(diagramFormatters["nooq.diagram/v1"]!(block as never, { text: () => "flowchart LR\n  X --> Y", children: "" } as never)).toBe("```mermaid\nflowchart LR\n  X --> Y\n```");
  });

  test("import: ```mermaid routes to DIAGRAM (not code); round trip identical", () => {
    const doc = importMarkdown("```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\nAfter");
    expect(doc).toHaveLength(2);
    expect(doc[0]!.data.type).toBe("nooq.diagram/v1");
    expect(doc[0]!.data.text!.s).toBe("sequenceDiagram\n  A->>B: hi");
    const e = new Editor({ docId: "dia-rt", actor: { actorId: "w" }, plugins: [essentials, diagramPlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    expect(exportMarkdown(e.view as never, { formatters: diagramFormatters }).markdown.trim()).toBe("```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\nAfter");
    e.close();
  });

  test("plain ```ts still routes to CODE (the seam is the info string)", () => {
    const doc = importMarkdown("```ts\nconst x = 1;\n```");
    expect(doc[0]!.data.type).toBe("nooq.code/v1");
    expect(doc[0]!.data.fields.lang).toBe("ts");
  });
});
