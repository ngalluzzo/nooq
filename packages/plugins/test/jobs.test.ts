import { expect, test } from "bun:test";
import { applyTransaction, emptyDocument, evaluate, makeBlock, type DocState, type Op } from "@nooq/core";
import { ProposalCapture, UnsupportedEvidenceError } from "../src/jobs.ts";

const actor = { actorId: "model", kind: "ai" as const, model: "local", plugin: "test.jobs" };
let lamport = 0;
const apply = (state: DocState, ops: Op[]) => applyTransaction(state, { id: crypto.randomUUID(), actor, lamport: ++lamport, causality: {}, ops });
function fixture() {
  let state = emptyDocument("capture");
  for (const [id, parent] of [["parent", null], ["source", "parent"], ["target", "parent"], ["child", "target"]] as const) {
    state = apply(state, [{ op: "insert", block: makeBlock({ id, type: "test/v1", fields: { value: id }, text: { s: "text", marks: [[], [], [], []] } }, actor.actorId), parent }]);
  }
  return state;
}
test("captures pin source-only reads and mandatory targets to the original immutable base", async () => {
  const state = fixture(), capture = new ProposalCapture(state);
  const [source] = capture.readBlocks(["source"]);
  expect(Object.isFrozen(source!.fields)).toBe(true);
  expect("attribution" in source!).toBe(false);
  const proposal = await capture.proposal([{ op: "setField", block: "target", key: "value", value: "new" }], actor);
  expect(proposal.evidence.map(e => e.block)).toEqual(["source", "target"]);
  expect((await evaluate(proposal, apply(state, [{ op: "setField", block: "source", key: "value", value: "changed" }]))).status).toBe("stale");
  expect((await evaluate(proposal, state)).status).toBe("fresh");
});
test("subtree reads pin descendant content and containing-block membership", async () => {
  const state = fixture(), capture = new ProposalCapture(state); capture.readSubtrees(["target"]);
  const proposal = await capture.proposal([{ op: "setField", block: "source", key: "value", value: "new" }], actor);
  expect(proposal.evidence.map(e => e.block)).toEqual(["child", "source", "target"]);
  expect((await evaluate(proposal, apply(state, [{ op: "setField", block: "child", key: "value", value: "changed" }]))).status).toBe("stale");
  const added = makeBlock({ id: "new-child", type: "test/v1" }, actor.actorId);
  expect((await evaluate(proposal, apply(state, [{ op: "insert", block: added, parent: "target" }]))).status).toBe("conflicted");
});
test("non-root structural batches cover parent and descendants, with no fabricated new-ID evidence", async () => {
  const state = fixture(), capture = new ProposalCapture(state), block = makeBlock({ id: "new", type: "test/v1" }, actor.actorId);
  const proposal = await capture.proposal([{ op: "insert", block, parent: "parent" }, { op: "move", block: "target", newParent: "new" }, { op: "setField", block: "new", key: "value", value: 1 }], actor);
  expect(proposal.evidence.map(e => e.block)).toEqual(["child", "parent", "target"]);
});
test("root placement, restore and tombstone reads fail explicitly; root-targeted field edits remain fresh", async () => {
  const state = fixture(), capture = new ProposalCapture(state);
  await expect(capture.proposal([{ op: "delete", block: "parent" }], actor)).rejects.toBeInstanceOf(UnsupportedEvidenceError);
  await expect(capture.proposal([{ op: "move", block: "target", newParent: null }], actor)).rejects.toBeInstanceOf(UnsupportedEvidenceError);
  await expect(capture.proposal([{ op: "restore", block: "target", parent: "parent" }], actor)).rejects.toBeInstanceOf(UnsupportedEvidenceError);
  expect(() => new ProposalCapture(apply(state, [{ op: "delete", block: "target" }])).readBlocks(["target"])).toThrow("tombstoned");
  const proposal = await capture.proposal([{ op: "setField", block: "parent", key: "value", value: "new" }], actor);
  const changedRoots = apply(state, [{ op: "insert", block: makeBlock({ type: "unrelated/v1" }, actor.actorId), parent: null }]);
  expect((await evaluate(proposal, changedRoots)).status).toBe("fresh");
});
