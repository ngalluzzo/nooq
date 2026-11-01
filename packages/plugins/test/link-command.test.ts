import { expect, test } from "bun:test";
import { applyTextChanges, emptyDocument, makeBlock, type DocState } from "@nooq/core";
import { prepareCommand } from "../src/index.ts";
import { essentials, link } from "../src/essentials.ts";

const actor = { actorId: "writer", kind: "human" as const };
const prepare = (doc: DocState, args: unknown) => prepareCommand(essentials, link.id, doc, actor, args);

function document(text: string, marks?: string[][]): { doc: DocState; block: string } {
  const doc = emptyDocument("links");
  const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: text, marks: marks ?? Array.from({ length: text.length }, () => [] as string[]) } }, "writer");
  doc.blocks[block.id] = block; doc.roots.push(block.id);
  return { doc, block: block.id };
}

test("nooq.text.link validates its arguments strictly", () => {
  const { doc, block } = document("the nooq docs");
  expect(prepare(doc, { block, from: 4, to: 8 }).status).toBe("not-applicable"); // nothing linked to remove yet
  expect(prepare(doc, { block, from: 4, to: 8, href: "https://nooq.dev" }).status).toBe("ready");
  for (const bad of [
    { block, from: 4, to: 8, href: "" }, // an empty href is not a link
    { block, from: 4, to: 8, href: 42 },
    { block, from: 1.5, to: 8, href: "https://nooq.dev" },
    { block, from: 4, to: "8", href: "https://nooq.dev" },
    { from: 4, to: 8, href: "https://nooq.dev" }, // missing block
  ]) expect(() => prepare(doc, bad)).toThrow("Invalid arguments");
});

test("a present href applies the reserved link base with intent add-link", () => {
  const { doc, block } = document("the nooq docs");
  const prepared = prepare(doc, { block, from: 4, to: 8, href: "https://nooq.dev" });
  if (prepared.status !== "ready") throw new Error(`expected ready, got ${prepared.status}`);
  expect(prepared.intent).toBe("add-link");
  expect(prepared.ops).toHaveLength(2);
  const [edit, field] = prepared.ops;
  if (edit.op !== "textEdit" || field.op !== "setField") throw new Error("expected textEdit then setField");
  expect(field.block).toBe(block);
  expect(field.key.startsWith("link:")).toBe(true);
  expect(field.value).toBe("https://nooq.dev");
  const changed = applyTextChanges(doc.blocks[block]!.text!, edit.changes);
  for (const [index, set] of changed.marks.entries()) {
    expect(set).toEqual(index >= 4 && index < 8 ? [field.key] : []);
  }
});

test("an absent href removes with intent remove-link and touches only marks", () => {
  const token = "link:9f2c1a";
  const { doc, block } = document("the nooq docs", Array.from({ length: 13 }, (_, i) => i >= 4 && i < 8 ? [token] : []));
  doc.blocks[block]!.fields[token] = "https://nooq.dev";
  const prepared = prepare(doc, { block, from: 4, to: 8 });
  if (prepared.status !== "ready") throw new Error(`expected ready, got ${prepared.status}`);
  expect(prepared.intent).toBe("remove-link");
  expect(prepared.ops).toHaveLength(1);
  expect(prepared.ops[0]!.op).toBe("textEdit");
});

test("the command declines non-inline, dead, and empty-range targets", () => {
  const { doc, block } = document("hi");
  expect(prepare(doc, { block: "deleted", from: 0, to: 1, href: "https://nooq.dev" }).status).toBe("not-applicable");
  const container = makeBlock({ type: "nooq.suggestion/v1", fields: {} }, "writer");
  doc.blocks[container.id] = container; doc.roots.push(container.id);
  expect(prepare(doc, { block: container.id, from: 0, to: 0, href: "https://nooq.dev" }).status).toBe("not-applicable");
  expect(prepare(doc, { block, from: 1, to: 1, href: "https://nooq.dev" }).status).toBe("not-applicable");
  expect(prepare(doc, { block, from: 1, to: 2 }).status).toBe("not-applicable"); // nothing linked to remove
  expect(() => prepare(doc, { block, from: 0, to: 99, href: "https://nooq.dev" })).toThrow("Selection out of range");
});
