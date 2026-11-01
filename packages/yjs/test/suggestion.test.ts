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
import { readState, textAuthors } from "../src/index.ts";
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
      expect(state.blocks[ids.p]!.attribution.fields.tone).toEqual({ actor: AI, lamport: 11, adoptedBy: P2 });
      // Two-level provenance stays in state: the settlement names its adopter (DM-6.3).
      expect(state.blocks[suggestion.id]!.attribution.fields.status).toEqual({ actor: AI, lamport: 11, adoptedBy: P2 });
    }
    // DM-14.2: every character's author is its item's registered client, on both peers.
    const adopted = { actorId: AI, kind: "ai" as const, model: "test-model", adoptedBy: P2 };
    for (const doc of [p1.doc, p2.doc]) {
      const runs = textAuthors(doc, ids.p);
      expect(runs.map((run) => run.length).reduce((a, b) => a + b, 0)).toBe("hello from the other peer".length);
      expect(runs.at(-1)).toEqual({ length: "from the other peer".length, author: adopted });
      expect(runs.every((run) => run.author !== undefined)).toBe(true);
    }
    expect(textAuthors(p1.doc, ids.p)).toEqual(textAuthors(p2.doc, ids.p));
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
