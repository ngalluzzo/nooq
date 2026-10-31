import { describe, expect, test } from "bun:test";
import { applyTransaction, evaluate, makeBlock } from "../src/index.ts";
import { buildFixture, evidenceFor, proposalAgainst, rt, tx } from "./helpers.ts";

describe("evaluate (DM-6.2/6.5)", () => {
  test("fresh: evidence intact", async () => {
    const { state, section, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [section, p]);
    const result = await evaluate(proposal, state);
    expect(result).toEqual({ status: "fresh", drift: [] });
  });

  test("stale on field drift (content)", async () => {
    const { state, section, p, h } = await buildFixture();
    const proposal = await proposalAgainst(state, [section, p]);
    const edited = applyTransaction(state, tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 5));
    const result = await evaluate(proposal, edited);
    expect(result.status).toBe("stale");
    expect(result.drift).toEqual([{ block: p, reason: "content" }]);
    void section; void h;
  });

  test("stale on text drift (content)", async () => {
    const { state, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [p]);
    const edited = applyTransaction(
      state,
      tx([{ op: "textEdit", block: p, replace: rt("hello world!") }], 5),
    );
    expect(await evaluate(proposal, edited)).toEqual({ status: "stale", drift: [{ block: p, reason: "content" }] });
  });

  test("conflicted on structural drift under an evidence ancestor", async () => {
    const { state, section, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [section]);
    // Move p within section: p's content is untouched, but section's children list changed.
    const moved = applyTransaction(state, tx([{ op: "move", block: p, newParent: section, index: 0 }], 5));
    const result = await evaluate(proposal, moved);
    expect(result.status).toBe("conflicted");
    expect(result.drift).toEqual([{ block: section, reason: "structure" }]);
  });

  test("conflicted on inserted sibling under an evidence ancestor", async () => {
    const { state, section } = await buildFixture();
    const proposal = await proposalAgainst(state, [section]);
    const grown = applyTransaction(
      state,
      tx([{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1" }, "human:2"), parent: section }], 5),
    );
    expect((await evaluate(proposal, grown)).status).toBe("conflicted");
  });

  test("conflicted on tombstoned target (DM-4.8 + DM-6.2)", async () => {
    const { state, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [p]);
    const deleted = applyTransaction(state, tx([{ op: "delete", block: p }], 5));
    expect(await evaluate(proposal, deleted)).toEqual({ status: "conflicted", drift: [{ block: p, reason: "tombstoned" }] });
  });

  test("conflicted on missing target", async () => {
    const { state, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [p]);
    const gc = structuredClone(state);
    delete gc.blocks[p];
    expect(await evaluate(proposal, gc)).toEqual({ status: "conflicted", drift: [{ block: p, reason: "missing" }] });
  });

  test("structural drift outranks content drift (deterministic precedence)", async () => {
    const { state, section, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [section, p]);
    const both = applyTransaction(state, tx([
      { op: "setField", block: p, key: "tone", value: "urgent" }, // content drift on p
      { op: "move", block: p, newParent: section, index: 0 },     // structural drift on section
    ], 5));
    const result = await evaluate(proposal, both);
    expect(result.status).toBe("conflicted");
    expect(result.drift).toHaveLength(2);
    // Drift entries are sorted by block ID; fixture UUIDs are random, so
    // assert order-insensitively.
    expect(result.drift).toContainEqual({ block: p, reason: "content" });
    expect(result.drift).toContainEqual({ block: section, reason: "structure" });
  });

  test("pure function: identical inputs, identical output", async () => {
    const { state, section, p } = await buildFixture();
    const proposal = await proposalAgainst(state, [section, p]);
    const edited = applyTransaction(state, tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 5));
    const a = await evaluate(proposal, edited);
    const b = await evaluate(proposal, edited);
    expect(a).toEqual(b);
  });

  test("evidence entries with wrong digests are drift, not errors", async () => {
    const { state, p } = await buildFixture();
    const evidence = await evidenceFor(state, [p]);
    const forged = [{ ...evidence[0]!, contentDigest: "sha256:" + "0".repeat(64) }];
    expect(await evaluate({ base: { rootDigest: "sha256:" + "0".repeat(64) }, ops: [], evidence: forged, context: null, actor: "ai:1" }, state))
      .toEqual({ status: "stale", drift: [{ block: p, reason: "content" }] });
  });
});
