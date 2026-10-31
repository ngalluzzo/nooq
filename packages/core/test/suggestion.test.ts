import { describe, expect, test } from "bun:test";
import {
  applyTransaction,
  computeDigests,
  evaluateSuggestion,
  liveTree,
  makeBlock,
  makeSuggestionBlock,
  replaceChanges,
  acceptChecked,
  rejectTransaction,
  rootDigest,
  StaleSuggestionError,
  type BlockId,
  type DocState,
  type Op,
  type Proposal,
} from "../src/index.ts";
import { buildFixture, rt, tx } from "./helpers.ts";

const AI = "ai:1";
const HUMAN = "human:2";

/** Build a suggestion block against this exact state and insert it as a root. */
async function propose(state: DocState, p: BlockId, section: BlockId, ops: Op[]): Promise<{ state: DocState; suggestion: BlockId }> {
  const digests = await computeDigests(state);
  const proposal: Proposal = {
    base: { rootDigest: await rootDigest(state) },
    ops,
    evidence: [p, section].sort().map((block) => {
      const info = digests.get(block)!;
      return { block, contentDigest: info.contentDigest, structureDigest: info.structureDigest };
    }),
    context: { model: "test-model" },
    actor: AI,
  };
  const suggestion = makeSuggestionBlock(proposal, AI);
  const withSuggestion = applyTransaction(
    state,
    tx([{ op: "insert", block: suggestion, parent: null }], 5, AI),
  );
  return { state: withSuggestion, suggestion: suggestion.id };
}

describe("suggestion lifecycle (DM-6.3/6.4)", () => {
  test("fresh accept applies ops verbatim with two-level provenance", async () => {
    const { state, section, p } = await buildFixture();
    const ops: Op[] = [
      { op: "setField", block: p, key: "tone", value: "urgent" },
      { op: "textEdit", block: p, changes: replaceChanges("hello world", "hello brave new world") },
    ];
    const setup = await propose(state, p, section, ops);
    const accept = await acceptChecked({
      state: setup.state,
      suggestion: setup.suggestion,
      actor: { actorId: HUMAN, kind: "human" },
      lamport: 10,
    });
    const accepted = applyTransaction(setup.state, accept);

    // Proposal ops applied verbatim
    expect(accepted.blocks[p]!.fields.tone).toBe("urgent");
    expect(accepted.blocks[p]!.text!.s).toBe("hello brave new world");
    // Suggestion tombstoned with verdict, payload persisting
    expect(liveTree(accepted).alive.has(setup.suggestion)).toBe(false);
    expect(accepted.blocks[setup.suggestion]!.fields.status).toBe("accepted");
    expect((accepted.blocks[setup.suggestion]!.fields.proposal as { ops: Op[] }).ops).toHaveLength(2);
    // Two-level provenance: tx authored by the AI, adoptedBy the human (DM-5)
    const logged = accepted.log.at(-1)!;
    expect(logged.actor.actorId).toBe(AI);
    expect(logged.actor.kind).toBe("ai");
    expect(logged.actor.model).toBe("test-model");
    expect(logged.adoptedBy).toBe(HUMAN);
    expect(logged.ops).toHaveLength(4); // 2 proposal ops + status + delete
    // Block-level attribution points at the AI (DM-5)
    expect(accepted.blocks[p]!.attribution.fields.tone).toEqual({ actor: AI, lamport: 10 });
  });

  test("acceptChecked refuses stale suggestions with the evaluation attached", async () => {
    const { state, section, p } = await buildFixture();
    const ops: Op[] = [{ op: "setField", block: p, key: "tone", value: "urgent" }];
    const setup = await propose(state, p, section, ops);
    const drifted = applyTransaction(
      setup.state,
      tx([{ op: "setField", block: p, key: "tone", value: "calm" }], 6, HUMAN),
    );
    const attempt = acceptChecked({
      state: drifted,
      suggestion: setup.suggestion,
      actor: { actorId: HUMAN, kind: "human" },
      lamport: 10,
    });
    await expect(attempt).rejects.toBeInstanceOf(StaleSuggestionError);
    await attempt.catch((error: StaleSuggestionError) => {
      expect(error.evaluation.status).toBe("stale");
      expect(error.evaluation.drift).toContainEqual({ block: p, reason: "content" });
    });
  });

  test("forced accept on stale content is permitted and recorded", async () => {
    const { state, section, p } = await buildFixture();
    const ops: Op[] = [{ op: "setField", block: p, key: "tone", value: "urgent" }];
    const setup = await propose(state, p, section, ops);
    const drifted = applyTransaction(
      setup.state,
      tx([{ op: "setField", block: p, key: "tone", value: "calm" }], 6, HUMAN),
    );
    const accept = await acceptChecked({
      state: drifted,
      suggestion: setup.suggestion,
      actor: { actorId: HUMAN, kind: "human" },
      lamport: 10,
      force: true,
    });
    expect(accept.intent).toContain(":stale");
    const accepted = applyTransaction(drifted, accept);
    expect(accepted.blocks[p]!.fields.tone).toBe("urgent"); // verbatim: the proposal wins over the drift
  });

  test("forced accept of a structurally drifted proposal fails loudly", async () => {
    const { state, section, p } = await buildFixture();
    const fresh = makeBlock({ type: "nooq.paragraph/v1" }, AI);
    const ops: Op[] = [{ op: "insert", block: fresh, parent: section, index: 3 }];
    const setup = await propose(state, p, section, ops);
    // Shrink section below index 3 -> structural drift + impossible index
    const drifted = applyTransaction(setup.state, tx([{ op: "delete", block: p }], 6, HUMAN));
    const accept = await acceptChecked({
      state: drifted,
      suggestion: setup.suggestion,
      actor: { actorId: HUMAN, kind: "human" },
      lamport: 10,
      force: true,
    });
    expect(() => applyTransaction(drifted, accept)).toThrow(/index/);
  });

  test("reject tombstones with the verdict and the payload persists", async () => {
    const { state, section, p } = await buildFixture();
    const ops: Op[] = [{ op: "setField", block: p, key: "tone", value: "urgent" }];
    const setup = await propose(state, p, section, ops);
    const reject = rejectTransaction({
      suggestion: setup.suggestion,
      actor: { actorId: HUMAN, kind: "human" },
      lamport: 7,
    });
    const rejected = applyTransaction(setup.state, reject);
    expect(liveTree(rejected).alive.has(setup.suggestion)).toBe(false);
    expect(rejected.blocks[setup.suggestion]!.fields.status).toBe("rejected");
    expect(rejected.blocks[setup.suggestion]!.fields.proposal).toBeDefined();
    expect(rejected.log.at(-1)!.actor.actorId).toBe(HUMAN);
    expect(rejected.blocks[p]!.fields.tone).toBeUndefined(); // untouched
  });

  test("evaluateSuggestion derives status from the block", async () => {
    const { state, section, p } = await buildFixture();
    const ops: Op[] = [{ op: "setField", block: p, key: "tone", value: "urgent" }];
    const setup = await propose(state, p, section, ops);
    expect((await evaluateSuggestion(setup.state, setup.suggestion)).status).toBe("fresh");
    const drifted = applyTransaction(setup.state, tx([{ op: "textEdit", block: p, changes: replaceChanges("hello world", "drift") }], 6, HUMAN));
    expect((await evaluateSuggestion(drifted, setup.suggestion)).status).toBe("stale");
  });
});
