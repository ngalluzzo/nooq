import { applyTransaction, computeDigests, emptyDocument, makeBlock, rootDigest, type BlockId, type DocState, type Op, type Proposal, type ProposalEvidenceEntry, type RenderedText, type Transaction } from "../src/index.ts";

/** Unmarked rendered text: one empty mark set per UTF-16 code unit. */
export function rt(s: string): RenderedText {
  return { s, marks: s.split("").map(() => []) };
}

export function tx(ops: Op[], lamport: number, actorId = "human:1"): Transaction {
  return { id: crypto.randomUUID(), actor: { actorId, kind: "human" }, lamport, causality: {}, ops };
}

export interface Fixture {
  state: DocState;
  section: BlockId;
  q: BlockId;
  p: BlockId;
  h: BlockId;
}

/** section -> [q, p, h]; q and p are paragraphs with text, h is a heading. */
export async function buildFixture(): Promise<Fixture> {
  const section = makeBlock({ type: "nooq.section/v1" }, "human:1");
  const q = makeBlock({ type: "nooq.paragraph/v1", text: rt("first") }, "human:1");
  const p = makeBlock({ type: "nooq.paragraph/v1", text: rt("hello world") }, "human:1");
  const h = makeBlock({ type: "nooq.heading/v1", fields: { level: 2 } }, "human:1");

  let state = emptyDocument("test-doc");
  state = applyTransaction(state, tx([{ op: "insert", block: section, parent: null }], 1));
  state = applyTransaction(state, tx([{ op: "insert", block: q, parent: section.id }], 2));
  state = applyTransaction(state, tx([{ op: "insert", block: p, parent: section.id }], 3));
  state = applyTransaction(state, tx([{ op: "insert", block: h, parent: section.id }], 4));
  return { state, section: section.id, q: q.id, p: p.id, h: h.id };
}

export async function evidenceFor(state: DocState, ids: readonly BlockId[]): Promise<ProposalEvidenceEntry[]> {
  const digests = await computeDigests(state);
  return ids.map((block) => {
    const info = digests.get(block);
    if (!info) throw new Error(`no digests for ${block}`);
    return { block, contentDigest: info.contentDigest, structureDigest: info.structureDigest };
  });
}

export async function proposalAgainst(state: DocState, ids: readonly BlockId[]): Promise<Proposal> {
  return {
    base: { rootDigest: await rootDigest(state) },
    ops: [],
    evidence: await evidenceFor(state, ids),
    context: { model: "test-model" },
    actor: "ai:1",
  };
}
