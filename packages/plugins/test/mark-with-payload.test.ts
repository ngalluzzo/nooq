import { expect, test } from "bun:test";
import { applyTextChanges, applyTransaction, emptyDocument, makeBlock, newBlockId, type DocState, type Op, type Transaction } from "@nooq/core";
import { defineBlock, definePlugin, markWithPayload, prepareCommand } from "../src/index.ts";

const note = defineBlock({ type: "test.note/v1", label: "Note", text: "inline", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
const box = defineBlock({ type: "test.box/v1", label: "Box", text: "none", create: () => ({ fields: {} }), diagnose: () => [] });
const marker = markWithPayload("test.mark", { id: "test.mark.apply", label: "Mark" });
const plugin = definePlugin({ id: "test", version: "1.0.0", apiVersion: 1, contributes: { commands: [marker] } });
const actor = { actorId: "writer", kind: "human" as const };

function seeded(text: string, marks?: string[][]): { doc: DocState; block: string } {
  const doc = emptyDocument("marks");
  const block = makeBlock({ type: note.type, text: { s: text, marks: marks ?? Array.from({ length: text.length }, () => [] as string[]) } }, "writer");
  doc.blocks[block.id] = block; doc.roots.push(block.id);
  return { doc, block: block.id };
}
const commit = (doc: DocState, ops: readonly Op[], intent: string): DocState => {
  const transaction: Transaction = { id: newBlockId(), actor, lamport: 1, causality: {}, intent, ops: [...ops] };
  return applyTransaction(doc, transaction);
};
const prepare = (doc: DocState, args: unknown) => prepareCommand(plugin, marker.id, doc, actor, args);

test("applying a payloaded mark is one transaction carrying the textEdit and the setField together", () => {
  const { doc, block } = seeded("hello world");
  const prepared = prepare(doc, { block, from: 6, to: 11, payload: { note: "payload" } });
  if (prepared.status !== "ready") throw new Error(`expected ready, got ${prepared.status}`);
  expect(prepared.intent).toBe("mark:test.mark");
  expect(prepared.ops).toHaveLength(2);
  const [edit, field] = prepared.ops;
  if (edit.op !== "textEdit" || field.op !== "setField") throw new Error("expected textEdit then setField");
  expect(field.block).toBe(block);
  expect(field.key.startsWith("test.mark:")).toBe(true);
  expect(field.key.length).toBeGreaterThan("test.mark:".length + 8); // block-id generator discipline, not a suffix
  expect(field.value).toEqual({ note: "payload" });
  const token = field.key;
  expect(applyTextChanges(doc.blocks[block]!.text!, edit.changes).marks.map(set => set.join(",")))
    .toEqual(["", "", "", "", "", "", token, token, token, token, token]);
  // One transaction lands both halves: token in marks, payload in fields.
  const after = commit(doc, prepared.ops, prepared.intent);
  expect(after.blocks[block]!.text!.marks[6]).toEqual([token]);
  expect(after.blocks[block]!.fields[token]).toEqual({ note: "payload" });
  expect(prepared.selection).toEqual({ block, anchor: 6, head: 11 });
});

test("every preparation mints a fresh token id", () => {
  const { doc, block } = seeded("hello");
  const first = prepare(doc, { block, from: 0, to: 5, payload: 1 }), second = prepare(doc, { block, from: 0, to: 5, payload: 2 });
  if (first.status !== "ready" || second.status !== "ready") throw new Error("expected ready");
  const keyOf = (op: Op) => op.op === "setField" ? op.key : "";
  expect(keyOf(first.ops[1]!)).not.toBe(keyOf(second.ops[1]!));
});

test("applying replaces a same-base token, preserves other marks, and orphans the old field (GC non-goal)", () => {
  const { doc, block } = seeded("abcd", [["strong"], ["strong", "test.mark:old"], ["strong", "test.mark:old"], ["strong"]]);
  doc.blocks[block]!.fields["test.mark:old"] = "old payload";
  const prepared = prepare(doc, { block, from: 0, to: 4, payload: "new" });
  if (prepared.status !== "ready") throw new Error("expected ready");
  const after = commit(doc, prepared.ops, prepared.intent);
  const token = Object.keys(after.blocks[block]!.fields).find(key => key.startsWith("test.mark:") && key !== "test.mark:old")!;
  expect(token).toBeDefined();
  for (const set of after.blocks[block]!.text!.marks) expect(set).toEqual(["strong", token]);
  expect(after.blocks[block]!.fields["test.mark:old"]).toBe("old payload"); // left behind, tolerated
});

test("the removal form clears the base's tokens, keeps other marks, and leaves the field", () => {
  const { doc, block } = seeded("abcd", [["strong"], ["link:old", "strong", "test.mark:t1"], ["test.mark:t1"], []]);
  doc.blocks[block]!.fields["test.mark:t1"] = "payload stays";
  const prepared = prepare(doc, { block, from: 0, to: 4 });
  if (prepared.status !== "ready") throw new Error("expected ready");
  expect(prepared.intent).toBe("unmark:test.mark");
  expect(prepared.ops).toHaveLength(1);
  expect(prepared.ops[0]!.op).toBe("textEdit"); // marks only, never a setField
  const after = commit(doc, prepared.ops, prepared.intent);
  expect(after.blocks[block]!.text!.marks).toEqual([["strong"], ["link:old", "strong"], [], []]);
  expect(after.blocks[block]!.fields["test.mark:t1"]).toBe("payload stays");
});

test("the recipe declines stale, structural, and no-op targets without mutating anything", () => {
  const { doc, block } = seeded("hi");
  expect(prepare(doc, { block: "missing", from: 0, to: 1, payload: true }).status).toBe("not-applicable");
  const boxed = makeBlock({ type: box.type, fields: {} }, "writer");
  doc.blocks[boxed.id] = boxed; doc.roots.push(boxed.id);
  expect(prepare(doc, { block: boxed.id, from: 0, to: 0, payload: true }).status).toBe("not-applicable"); // non-inline
  expect(prepare(doc, { block, from: 1, to: 1, payload: true }).status).toBe("not-applicable"); // empty range
  expect(prepare(doc, { block, from: 1, to: 2 }).status).toBe("not-applicable"); // removal over unmarked text
  expect(() => prepare(doc, { block, from: 0, to: 9, payload: true })).toThrow("Selection out of range");
  expect(() => prepare(doc, { block, from: -1, to: 2, payload: true })).toThrow("Selection out of range");
  for (const args of [{ block, from: 0.5, to: 1, payload: true }, { block, from: 0, to: 1, payload: NaN }, { block, from: 0, to: "1", payload: true }]) {
    expect(() => prepare(doc, args)).toThrow("Invalid arguments");
  }
  expect(() => markWithPayload("bad:base", { id: "x", label: "X" })).toThrow("Mark base");
});
