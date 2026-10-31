import { expect, test } from "bun:test";
import { emptyDocument, makeBlock, canonicalJson } from "@nooq/core";
import { defineBlockSchema, field, cycleFieldCommand, setFieldCommand, insertBlockCommand, definePlugin, prepareCommand, type FieldValues } from "../src/index.ts";

const note = defineBlockSchema({ type: "test.note/v1", label: "Note", text: "inline", fields: {
  tone: field.enum(["info", "warning", "success"], "info"), title: field.string(), count: field.number(), folded: field.boolean(),
} });
const cycle = cycleFieldCommand(note, "tone", { id: "note.cycle", label: "Cycle" });
const set = setFieldCommand(note, "tone", { id: "note.set", label: "Set" });
const insert = insertBlockCommand(note, { id: "note.insert", label: "Insert" });
const plugin = definePlugin({ id: "test", version: "1.0.0", apiVersion: 1, contributes: { blocks: [note], commands: [cycle, set, insert] } });

test("schema derives fresh creation defaults and non-destructive diagnostics", () => {
  const a = note.create(), b = note.create(); a.fields.tone = "warning"; a.text!.marks.push(["future"]);
  expect(b.fields).toEqual({ tone: "info", title: "", count: 0, folded: false }); expect(b.text!.marks).toEqual([]);
  const old = makeBlock({ type: note.type, fields: { tone: "future", future: { nested: true } } }, "writer");
  const before = canonicalJson(old);
  expect(note.diagnose(old).map(d => d.field)).toEqual(["tone", "title", "count", "folded"]);
  expect(canonicalJson(old)).toBe(before);
  expect(() => field.enum(["a", "a"], "a")).toThrow(); expect(() => field.number(NaN)).toThrow();
  const typed: FieldValues<typeof note.fields> = { tone: "info", title: "", count: 1, folded: false };
  // @ts-expect-error enum values remain a literal union
  typed.tone = "invalid";
});

test("standard field commands validate, preserve unknown content, and decline invalid targets", () => {
  const doc = emptyDocument("recipes"), target = makeBlock({ type: note.type, fields: { ...note.create().fields, future: { keep: true } }, text: { s: "A😀B", marks: [[], ["future"], ["future"], []] } }, "writer");
  doc.blocks[target.id] = target; doc.roots.push(target.id);
  const prepare = (id: string, args: unknown) => prepareCommand(plugin, id, doc, { actorId: "writer", kind: "human" }, args);
  const before = canonicalJson(doc);
  expect(prepare(cycle.id, { block: target.id })).toMatchObject({ status: "ready", ops: [{ op: "setField", block: target.id, key: "tone", value: "warning" }] });
  expect(canonicalJson(doc)).toBe(before);
  expect(prepare(cycle.id, { block: "missing" }).status).toBe("not-applicable");
  target.fields.tone = "future";
  expect(prepare(cycle.id, { block: target.id }).status).toBe("not-applicable");
  expect(prepare(set.id, { block: target.id, value: "info" }).status).toBe("ready");
  expect(() => prepare(set.id, { block: target.id, value: "bad" })).toThrow("Invalid arguments");
  target.type = "other/v1"; expect(prepare(cycle.id, { block: target.id }).status).toBe("not-applicable");
});

test("insertion consumes a current slash atomically and rejects stale placement", () => {
  const doc = emptyDocument("recipes"), source = makeBlock({ type: note.type, text: { s: "/", marks: [[]] } }, "writer");
  doc.blocks[source.id] = source; doc.roots.push(source.id);
  const prepare = (args: unknown) => prepareCommand(plugin, insert.id, doc, { actorId: "writer", kind: "human" }, args);
  for (const index of [-1, 1.5, Infinity]) expect(() => prepare({ parent: null, index })).toThrow("Invalid arguments");
  expect(prepare({ parent: null, index: 2 }).status).toBe("not-applicable");
  expect(prepare({ parent: "absent" }).status).toBe("not-applicable");
  const args = { parent: null, index: 1, clearBlock: source.id }, a = prepare(args), b = prepare(args);
  expect(a.status).toBe("ready"); expect(b.status).toBe("ready");
  if (a.status !== "ready" || b.status !== "ready") throw new Error("Expected ready");
  expect(a.ops.map(op => op.op)).toEqual(["textEdit", "insert"]); expect(a.selection!.block).not.toBe(b.selection!.block);
  source.text!.s = "/remote"; expect(prepare(args).status).toBe("not-applicable");
});
