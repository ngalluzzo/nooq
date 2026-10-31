import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computeDigests,
  evaluate,
  rootDigest,
  type BlockId,
  type DocState,
  type Proposal,
} from "@nooq/core";
import { normalize, readState } from "../src/index.ts";
import { makePeers, mulberry32, randomTx, sync } from "./helpers.ts";

async function proposalAgainst(state: DocState, ids: readonly BlockId[]): Promise<Proposal> {
  const digests = await computeDigests(state);
  return {
    base: { rootDigest: await rootDigest(state) },
    ops: [],
    evidence: ids.map((block) => {
      const info = digests.get(block)!;
      return { block, contentDigest: info.contentDigest, structureDigest: info.structureDigest };
    }),
    context: null,
    actor: "ai:1",
  };
}

describe("convergence under random op storms", () => {
  test(
    "two peers converge; evaluate() agrees on both; normalize is idempotent",
    async () => {
      for (let seed = 1; seed <= 24; seed++) {
        const rng = mulberry32(seed * 7919);
        const { p1, p2, ids } = makePeers();
        const evidenceIds = [ids.section, ids.p, ids.q].sort();
        const proposal = await proposalAgainst(p1.mirror, evidenceIds);

        const steps = 24 + Math.floor(rng() * 24);
        for (let i = 0; i < steps; i++) {
          randomTx(p1, rng);
          randomTx(p2, rng);
        }
        sync(p1.doc, p2.doc);

        const s1 = readState(p1.doc);
        const s2 = readState(p2.doc);
        expect(canonicalJson(s1)).toBe(canonicalJson(s2));
        expect(await rootDigest(s1)).toBe(await rootDigest(s2));

        const e1 = await evaluate(proposal, s1);
        const e2 = await evaluate(proposal, s2);
        expect(e1).toEqual(e2);

        normalize(p1.doc);
        normalize(p2.doc);
        sync(p1.doc, p2.doc);
        expect(canonicalJson(readState(p1.doc))).toBe(canonicalJson(readState(p2.doc)));
      }
    },
    120_000,
  );

  test(
    "two-round storms with an intermediate merge also converge",
    async () => {
      for (const seed of [3, 17, 101]) {
        const rng = mulberry32(seed);
        const { p1, p2 } = makePeers();
        for (let i = 0; i < 15; i++) {
          randomTx(p1, rng);
          randomTx(p2, rng);
        }
        sync(p1.doc, p2.doc);
        // Mirrors are pre-merge views; after a merge the projection IS the
        // authoritative engine state, so validation continues from it.
        p1.mirror = readState(p1.doc);
        p2.mirror = readState(p2.doc);
        for (let i = 0; i < 15; i++) {
          randomTx(p1, rng);
          randomTx(p2, rng);
        }
        sync(p1.doc, p2.doc);
        expect(canonicalJson(readState(p1.doc))).toBe(canonicalJson(readState(p2.doc)));
      }
    },
    120_000,
  );

  test(
    "a stale suggestion is detected identically after a storm",
    async () => {
      const rng = mulberry32(4242);
      const { p1, p2, ids } = makePeers();
      const proposal = await proposalAgainst(p1.mirror, [ids.p]);
      // peer2 drifts the target's content; peer1 does unrelated work
      randomTx(p2, rng);
      sync(p1.doc, p2.doc);
      const s1 = readState(p1.doc);
      const s2 = readState(p2.doc);
      const e1 = await evaluate(proposal, s1);
      expect(e1).toEqual(await evaluate(proposal, s2));
      // The storm will almost surely have touched ids.p or its container;
      // whatever the outcome, both peers must agree on it.
      expect(["fresh", "stale", "conflicted"]).toContain(e1.status);
    },
    60_000,
  );
});
