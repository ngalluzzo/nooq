import { describe, expect, test } from "bun:test";
import { inverseOf, makeBlock, newBlockId, type DocState, type Op, type Transaction } from "@nooq/core";
import { applyTransaction, newDocument, readState } from "@nooq/yjs";

/** DM-4.10: the inverse restores the pre-state — the property that IS undo,
 *  applied through the REAL machinery (yjs applyTransaction, the product's
 *  own road), not a test-only shortcut. */
const actor = { actorId: "human:w", kind: "human" as const };
let lamport = 0;
const txOf = (ops: Op[]): Transaction => ({ id: newBlockId(), actor, lamport: ++lamport, causality: {}, ops });
const paragraph = (text: string) => makeBlock({ type: "nooq.paragraph/v1", fields: {}, text: { s: text, marks: text.split("").map(() => []) } }, actor.actorId);

function roundTrip(setup: Op[], action: Op[]): { pre: DocState; post: DocState; undone: DocState } {
  const doc = newDocument("rt");
  applyTransaction(doc, txOf(setup));
  const pre = structuredClone(readState(doc));
  const tx = txOf(action);
  applyTransaction(doc, tx);
  const post = readState(doc);
  const inverse = inverseOf(pre, tx);
  if (inverse === undefined) throw new Error("non-invertible");
  applyTransaction(doc, txOf(inverse));
  return { pre, post: structuredClone(post), undone: readState(doc) };
}

describe("inverseOf: the round trip (apply → inverse → the pre-state, exactly)", () => {
  test("insert: the inverse deletes; delete's inverse RESTORES content and placement", () => {
    const { pre, undone } = roundTrip(
      [{ op: "insert", block: paragraph("first"), parent: null }],
      [{ op: "insert", block: paragraph("second"), parent: null, index: 1 }],
    );
    expect(undone.roots).toEqual(pre.roots);
    expect(undone.roots).toHaveLength(1);

    const victim = paragraph("first");
    const del = roundTrip([{ op: "insert", block: victim, parent: null }], [{ op: "delete", block: victim.id }]);
    expect(del.post.roots).toHaveLength(0);
    expect(del.undone.roots).toEqual([victim.id]);
    expect(del.undone.blocks[victim.id]!.text!.s).toBe("first"); // the tombstone kept it; restore brought it back
  });

  test("textEdit: typing, backspace, tail-appends, whole-deletes — all invert exactly", () => {
    const block = paragraph("world");
    const splices: readonly import("@nooq/core").TextChange[][] = [
      [{ insert: "hello" }],
      [{ retain: 2 }, { delete: 1 }, { insert: "X" }],
      [{ retain: 5 }, { insert: " tail" }],
      [{ delete: 5 }],
      [{ insert: "AB" }, { retain: 1 }, { insert: "CD" }, { retain: 4 }],
    ];
    for (const changes of splices) {
      const { pre, undone } = roundTrip([{ op: "insert", block, parent: null }], [{ op: "textEdit", block: block.id, changes }]);
      expect(undone.blocks[block.id]!.text!.s).toBe("world");
      expect(undone.blocks[block.id]!.text!.marks).toEqual(pre.blocks[block.id]!.text!.marks);
    }
  });

  test("setField: the old value returns; a first-set's undo leaves the key (DM-4.10's stated limit)", () => {
    const block = makeBlock({ type: "nooq.heading/v1", fields: { level: 2 }, text: { s: "H", marks: [[]] } }, actor.actorId);
    const { undone } = roundTrip([{ op: "insert", block, parent: null }], [{ op: "setField", block: block.id, key: "level", value: 3 }]);
    expect(undone.blocks[block.id]!.fields.level).toBe(2);

    const first = inverseOf(
      (() => { const doc = newDocument("first"); applyTransaction(doc, txOf([{ op: "insert", block, parent: null }])); return structuredClone(readState(doc)); })(),
      txOf([{ op: "setField", block: block.id, key: "tone", value: "warm" }]),
    )!;
    expect(first).toHaveLength(0); // cannot un-set a first key — stated, honest
  });

  test("move: the inverse returns the block to parent and index", () => {
    const a = paragraph("a"), b = paragraph("b");
    const { pre, undone } = roundTrip(
      [{ op: "insert", block: a, parent: null }, { op: "insert", block: b, parent: null, index: 0 }],
      [{ op: "move", block: b.id, newParent: null, index: 1 }],
    );
    expect(undone.roots).toEqual(pre.roots);
    expect(pre.roots).toEqual([b.id, a.id]);
  });

  test("multi-op transactions invert as one: ops reverse, state round-trips", () => {
    const a = paragraph("one");
    const { pre, undone } = roundTrip(
      [{ op: "insert", block: a, parent: null }],
      [
        { op: "textEdit", block: a.id, changes: [{ insert: "ONE " }] },
        { op: "insert", block: paragraph("two"), parent: null, index: 1 },
      ],
    );
    expect(undone.roots).toEqual(pre.roots);
    expect(undone.blocks[a.id]!.text!.s).toBe("one");
  });

  test("access writes are the exception: no inverse, by design (0012)", () => {
    const doc = newDocument("acc");
    const pre = readState(doc);
    expect(inverseOf(pre, txOf([{ op: "setAccess", access: { owner: { actorId: "human:w", key: "k", kind: "human" }, grants: [], nonce: "n" } }]))).toBeUndefined();
  });
});

