import { describe, expect, test } from "bun:test";
import { applyTransaction, emptyDocument, makeBlock, newBlockId, validateTransaction, type Op, type Transaction } from "../src/index.ts";

const tx = (ops: Op[]): Transaction => ({ id: newBlockId(), actor: { actorId: "h", kind: "human" }, lamport: 1, causality: {}, ops });

function doc() {
  let state = emptyDocument("fast");
  const a = makeBlock({ type: "nooq.paragraph/v1", text: { s: "hello", marks: [[], [], [], [], []] } }, "h");
  state = applyTransaction(state, tx([{ op: "insert", block: a, parent: null }])); // pure: reassign
  return { state, a };
}

describe("read-only fast validation (EB-6)", () => {
  test("valid textEdit validates WITHOUT mutating the shared state", () => {
    const { state, a } = doc();
    const before = JSON.stringify(state.blocks[a.id]);
    void structuredClone;
    expect(() => validateTransaction(state, tx([{ op: "textEdit", block: a.id, changes: [{ insert: "X" }] }]))).not.toThrow();
    expect(JSON.stringify(state.blocks[a.id])).toBe(before); // untouched
  });

  test("out-of-range splice throws identically to the full path", () => {
    const { state, a } = doc();
    const full = structuredClone(state);
    const bad = tx([{ op: "textEdit", block: a.id, changes: [{ retain: 99 }, { delete: 5 }] }]);
    expect(() => validateTransaction(state, bad)).toThrow();
    expect(() => validateTransaction(full, bad)).toThrow();
  });

  test("tombstoned target throws", () => {
    let { state, a } = doc();
    state = applyTransaction(state, tx([{ op: "delete", block: a.id }]));
    expect(() => validateTransaction(state, tx([{ op: "textEdit", block: a.id, changes: [{ insert: "x" }] }]))).toThrow(/tombstoned/);
  });

  test("structural ops still take the full path (equivalence oracle)", () => {
    const { state, a } = doc();
    const section = makeBlock({ type: "nooq.section/v1" }, "h");
    const move = tx([{ op: "insert", block: section, parent: null }, { op: "move", block: a.id, newParent: section.id }]);
    const reference = structuredClone(state);
    expect(() => validateTransaction(reference, move)).not.toThrow();
    expect(reference.blocks[section.id]).toBeDefined(); // full path consumed its state
  });

  test("adoption transactions never take the fast path", () => {
    const { state, a } = doc();
    const adoption = tx([{ op: "textEdit", block: a.id, changes: [{ insert: "y" }] }]);
    (adoption as { adoptedBy?: string }).adoptedBy = "human:x";
    const before = JSON.stringify(state.blocks[a.id]);
    expect(() => validateTransaction(state, adoption)).not.toThrow();
    // full path consumed the state
    expect(JSON.stringify(state.blocks[a.id])).not.toBe(before);
  });
});
