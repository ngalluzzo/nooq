import { describe, expect, test } from "bun:test";
import {
  acceptChecked,
  replaceChanges,
  applyTransaction as engineApply,
  canonicalJson,
  evaluateSuggestion,
  liveTree,
  makeBlock,
  makeSuggestionBlock,
  type Op,
} from "@nooq/core";
import { readState } from "../src/index.ts";
import { AI, P1, P2, applyToPeer, makePeers, proposalAgainst, rt, sync, txOf } from "./helpers.ts";

describe("cross-peer suggestion lifecycle (DM-6.3 over replication)", () => {
  test("proposed on one peer, accepted on another, converges", async () => {
    const { p1, p2, ids } = makePeers();
    const ops: Op[] = [
      { op: "setField", block: ids.p, key: "tone", value: "urgent" },
      { op: "textEdit", block: ids.p, changes: replaceChanges("hello world", "hello from the other peer") },
      { op: "insert", block: makeBlock({ type: "nooq.paragraph/v1", text: rt("appended by ai") }, AI), parent: ids.section, index: 3 },
    ];
    const proposal = await proposalAgainst(p1.mirror, [ids.section, ids.p], ops);
    const suggestion = makeSuggestionBlock(proposal, AI);
    applyToPeer(p1, txOf([{ op: "insert", block: suggestion, parent: null }], 10, AI));
    sync(p1.doc, p2.doc);

    // Peer 2 sees a fresh suggestion and accepts it.
    const view2 = readState(p2.doc);
    expect((await evaluateSuggestion(view2, suggestion.id)).status).toBe("fresh");
    const accept = await acceptChecked({
      state: view2,
      suggestion: suggestion.id,
      actor: { actorId: P2, kind: "human" },
      lamport: 11,
    });
    applyToPeer(p2, accept);
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    const s2 = readState(p2.doc);
    expect(canonicalJson(s1)).toBe(canonicalJson(s2));

    for (const state of [s1, s2]) {
      expect(liveTree(state).alive.has(suggestion.id)).toBe(false);
      expect(state.blocks[suggestion.id]!.fields.status).toBe("accepted");
      expect(state.blocks[ids.p]!.fields.tone).toBe("urgent");
      expect(state.blocks[ids.p]!.text!.s).toBe("hello from the other peer");
      expect(state.blocks[ids.p]!.attribution.fields.tone).toEqual({ actor: AI, lamport: 11 });
      expect(state.blocks[ids.p]!.attribution.text).toEqual({ actor: AI, lamport: 11 });
    }
    // The adoption transaction, with two-level provenance, is in both logs.
    const adoptTx = s1.log.find((t) => t.adoptedBy === P2);
    expect(adoptTx).toBeDefined();
    expect(adoptTx!.actor.actorId).toBe(AI);
  });

  test("both peers accept concurrently: converges with a single inserted block", async () => {
    const { p1, p2, ids } = makePeers();
    const extra = makeBlock({ type: "nooq.paragraph/v1", text: rt("double accepted") }, AI);
    const ops: Op[] = [{ op: "insert", block: extra, parent: ids.section, index: 3 }];
    const proposal = await proposalAgainst(p1.mirror, [ids.section, ids.p], ops);
    const suggestion = makeSuggestionBlock(proposal, AI);
    applyToPeer(p1, txOf([{ op: "insert", block: suggestion, parent: null }], 10, AI));
    sync(p1.doc, p2.doc);

    const accept1 = await acceptChecked({
      state: readState(p1.doc),
      suggestion: suggestion.id,
      actor: { actorId: P1, kind: "human" },
      lamport: 11,
    });
    const accept2 = await acceptChecked({
      state: readState(p2.doc),
      suggestion: suggestion.id,
      actor: { actorId: P2, kind: "human" },
      lamport: 11,
    });
    applyToPeer(p1, accept1);
    applyToPeer(p2, accept2);
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    const s2 = readState(p2.doc);
    expect(canonicalJson(s1)).toBe(canonicalJson(s2));
    expect(liveTree(s1).alive.has(suggestion.id)).toBe(false);
    expect(s1.blocks[suggestion.id]!.fields.status).toBe("accepted");
    // The proposed block exists exactly once, under section (DM-3.1 survives double application).
    expect(liveTree(s1).alive.has(extra.id)).toBe(true);
    const occurrences =
      s1.blocks[ids.section]!.children.filter((child) => child === extra.id).length +
      (s1.roots.includes(extra.id) ? 1 : 0);
    expect(occurrences).toBe(1);
    expect(s1.blocks[extra.id]!.text!.s).toBe("double accepted");
  });
});
