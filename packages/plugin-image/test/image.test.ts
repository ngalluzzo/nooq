import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { image, imagePlugin } from "../src/index.ts";
import { imageFormatters } from "../src/export.ts";
import { importMarkdown, exportMarkdown } from "@nooq/plugins";
import { essentials, importBlocks } from "@nooq/plugins/essentials";
import { Editor } from "@nooq/editor";

describe("image blocks (embeds v1)", () => {
  test("the block: caption-as-text, src a field, honest diagnostic when absent", () => {
    expect(image.type).toBe("nooq.image/v1");
    const created = image.create();
    expect(created.fields.src).toBe("");
    expect(created.text).toEqual({ s: "", marks: [] });
    expect(image.diagnose(created as never)).toHaveLength(1); // no source, said out loud
    expect(imagePlugin.contributes.blocks).toHaveLength(1);
  });

  test("export: ![caption](src); alt rides when the field names one", () => {
    const block = { id: "i", type: "nooq.image/v1", fields: { src: "https://nooq.dev/cat.png" }, text: { s: "A cat", marks: [] }, children: [] } as never;
    const fmt = imageFormatters["nooq.image/v1"]!;
    expect(fmt(block as never, { text: () => "A cat", children: "" } as never)).toBe("![A cat](https://nooq.dev/cat.png)");
    const withAlt = { id: "i2", type: "nooq.image/v1", fields: { src: "u", alt: "Precise alt" }, text: { s: "caption", marks: [] }, children: [] } as never;
    expect(fmt(withAlt as never, { text: () => "caption", children: "" } as never)).toBe("![Precise alt](u)");
  });

  test("import: ![alt](src) becomes an image block; the round trip is identical", () => {
    const doc = importMarkdown("![A cat](https://nooq.dev/cat.png)\n\nAfter");
    expect(doc).toHaveLength(2);
    expect(doc[0]!.data.type).toBe("nooq.image/v1");
    expect(doc[0]!.data.fields.src).toBe("https://nooq.dev/cat.png");
    expect(doc[0]!.data.text!.s).toBe("A cat");
    const e = new Editor({ docId: "img-rt", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    expect(exportMarkdown(e.view as never, { formatters: imageFormatters }).markdown.trim()).toBe("![A cat](https://nooq.dev/cat.png)\n\nAfter");
    e.close();
  });

  test("the digest field rides: a host-provided digest lands in the same insert", () => {
    const e = new Editor({ docId: "img-d", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.insertBlock({ type: "nooq.image/v1", parent: null, fields: { src: "u", digest: "sha256-abc" } });
    const img = e.view.roots[1]!;
    expect(e.view.blocks[img]!.fields.digest).toBe("sha256-abc"); // 0014's limb, present from day one
    e.close();
  });
});
