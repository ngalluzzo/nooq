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

describe("the blob limb (0014's render path)", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  test("a nooq-blob: src renders through the host's verified channel", async () => {
    const { imageDOM } = await import("../src/dom.ts");
    const fetched: string[] = [];
    const dom = imageDOM({ fetchBlob: async digest => { fetched.push(digest); return pngBytes; } });
    // Mount through a real editor surface
    const { createSurface } = await import("@nooq/editor");
    const e = new Editor({ docId: "blob-img", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    const id = e.insertBlock({ type: "nooq.image/v1", parent: null, fields: { src: `nooq-blob:sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` }, text: "pic" });
    const surface = createSurface(e, { plugins: [dom] });
    document.body.append(surface.element);
    await new Promise(resolve => setTimeout(resolve, 20));
    const img = document.body.querySelector<HTMLImageElement>(".nq-image-picture")!;
    expect(fetched).toEqual([`sha256:${"a".repeat(64)}`]); // the digest went to the channel
    expect(img.getAttribute("src")).toContain("blob:"); // rendered from verified bytes
    surface.destroy(); e.close();
  });

  test("src and digest disagree: the honest error, no broken img", async () => {
    const { imageDOM } = await import("../src/dom.ts");
    const dom = imageDOM({ fetchBlob: async () => pngBytes });
    const { createSurface } = await import("@nooq/editor");
    const e = new Editor({ docId: "blob-dis", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.insertBlock({ type: "nooq.image/v1", parent: null, fields: { src: `nooq-blob:sha256:${"b".repeat(64)}`, digest: `sha256:${"c".repeat(64)}` }, text: "pic" });
    const surface = createSurface(e, { plugins: [dom] });
    document.body.append(surface.element);
    await new Promise(resolve => setTimeout(resolve, 20));
    const shell = document.body.querySelector<HTMLElement>(".nq-image")!;
    expect(shell.getAttribute("data-error")).toContain("disagree");
    surface.destroy(); e.close();
  });

  test("no fetcher with a blob src: 'This host cannot fetch stored images.'", async () => {
    const { imageDOM } = await import("../src/dom.ts");
    const dom = imageDOM({}); // a host with URL storage only
    const { createSurface } = await import("@nooq/editor");
    const e = new Editor({ docId: "blob-none", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.insertBlock({ type: "nooq.image/v1", parent: null, fields: { src: `nooq-blob:sha256:${"d".repeat(64)}` }, text: "pic" });
    const surface = createSurface(e, { plugins: [dom] });
    document.body.append(surface.element);
    await new Promise(resolve => setTimeout(resolve, 20));
    const shell = document.body.querySelector<HTMLElement>(".nq-image")!;
    expect(shell.getAttribute("data-error")).toContain("cannot fetch");
    surface.destroy(); e.close();
  });

  test("a failed fetch (the store's verification rejects): the honest error", async () => {
    const { imageDOM } = await import("../src/dom.ts");
    const dom = imageDOM({ fetchBlob: async () => { throw new Error("digest mismatch: expected x, got y"); } });
    const { createSurface } = await import("@nooq/editor");
    const e = new Editor({ docId: "blob-bad", actor: { actorId: "w" }, plugins: [essentials, imagePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    e.insertBlock({ type: "nooq.image/v1", parent: null, fields: { src: `nooq-blob:sha256:${"e".repeat(64)}` }, text: "pic" });
    const surface = createSurface(e, { plugins: [dom] });
    document.body.append(surface.element);
    await new Promise(resolve => setTimeout(resolve, 20));
    const shell = document.body.querySelector<HTMLElement>(".nq-image")!;
    expect(shell.getAttribute("data-error")).toContain("could not be fetched");
    surface.destroy(); e.close();
  });
});
