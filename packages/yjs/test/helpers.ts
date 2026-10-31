import * as Y from "yjs";
import {
  applyTransaction as engineApply,
  computeDigests,
  emptyDocument,
  liveTree,
  makeBlock,
  newBlockId,
  rootDigest,
  type BlockId,
  type DocState,
  type JsonValue,
  type Op,
  type Proposal,
  type RenderedText,
  type Transaction,
} from "@nooq/core";
import { applyTransaction as yjsApply, newDocument, readState } from "../src/index.ts";

export const P1 = "human:p1";
export const P2 = "human:p2";
export const AI = "ai:1";
export const DOC = "storm-doc";

/** Capture a proposal (evidence + ops) against this exact state. */
export async function proposalAgainst(
  state: DocState,
  ids: readonly BlockId[],
  ops: Op[] = [],
): Promise<Proposal> {
  const digests = await computeDigests(state);
  return {
    base: { rootDigest: await rootDigest(state) },
    ops,
    evidence: [...ids].sort().map((block) => {
      const info = digests.get(block)!;
      return { block, contentDigest: info.contentDigest, structureDigest: info.structureDigest };
    }),
    context: { model: "test-model" },
    actor: AI,
  };
}

export function txOf(ops: Op[], lamport: number, actorId: string): Transaction {
  return { id: newBlockId(), actor: { actorId, kind: "human" }, lamport, causality: {}, ops };
}

/** Rendered text with optional mark runs; sets are deduped and sorted (DM-3.3). */
export function rt(s: string, runs: Array<{ from: number; to: number; mark: string }> = []): RenderedText {
  const marks = s.split("").map(() => new Set<string>());
  for (const run of runs) {
    for (let i = Math.max(0, run.from); i < Math.min(run.to, s.length); i++) marks[i]!.add(run.mark);
  }
  return { s, marks: marks.map((set) => [...set].sort()) };
}

export interface FixtureIds {
  section: BlockId;
  q: BlockId;
  p: BlockId;
  h: BlockId;
  other: BlockId;
  c: BlockId;
}

/** Shared history: section -> [q, p, h]; other -> [c]; section and other are roots. */
export function baseTransactions(): { txs: Transaction[]; ids: FixtureIds } {
  const section = makeBlock({ type: "nooq.section/v1" }, P1);
  const q = makeBlock({ type: "nooq.paragraph/v1", text: rt("first") }, P1);
  const p = makeBlock({ type: "nooq.paragraph/v1", text: rt("hello world") }, P1);
  const h = makeBlock({ type: "nooq.heading/v1", fields: { level: 2 } }, P1);
  const other = makeBlock({ type: "nooq.section/v1" }, P1);
  const c = makeBlock({ type: "nooq.paragraph/v1", text: rt("c") }, P1);
  const txs = [
    txOf([{ op: "insert", block: section, parent: null }], 1, P1),
    txOf([{ op: "insert", block: q, parent: section.id }], 2, P1),
    txOf([{ op: "insert", block: p, parent: section.id }], 3, P1),
    txOf([{ op: "insert", block: h, parent: section.id }], 4, P1),
    txOf([{ op: "insert", block: other, parent: null }], 5, P1),
    txOf([{ op: "insert", block: c, parent: other.id }], 6, P1),
  ];
  return { txs, ids: { section: section.id, q: q.id, p: p.id, h: h.id, other: other.id, c: c.id } };
}

export interface Peer {
  doc: Y.Doc;
  /** Engine mirror: validates every op exactly like the sequential engine before it reaches Yjs. */
  mirror: DocState;
  lamport: number;
  actor: string;
}

export function applyToPeer(peer: Peer, t: Transaction): void {
  try {
    peer.mirror = engineApply(peer.mirror, t);
  } catch {
    // The local mirror only tracks this peer's own transactions; a tx may
    // legitimately reference remote blocks known to the merged doc. Fall
    // back to validating against the authoritative projection, then adopt
    // it as the mirror. Genuinely invalid txs still throw here.
    const view = readState(peer.doc);
    peer.mirror = engineApply(view, t);
  }
  peer.lamport = Math.max(peer.lamport, t.lamport);
  yjsApply(peer.doc, t);
}

export function makePeers(): { p1: Peer; p2: Peer; ids: FixtureIds } {
  const { txs, ids } = baseTransactions();
  const build = (actor: string): Peer => {
    const peer: Peer = { doc: newDocument(DOC), mirror: emptyDocument(DOC), lamport: 0, actor };
    for (const t of txs) applyToPeer(peer, t);
    return peer;
  };
  const p1 = build(P1);
  const p2 = build(P2);
  sync(p1.doc, p2.doc);
  return { p1, p2, ids };
}

export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = "abcdefg hij";

export function randomText(rng: () => number): RenderedText {
  const length = Math.floor(rng() * 12);
  let s = "";
  for (let i = 0; i < length; i++) s += CHARS[Math.floor(rng() * CHARS.length)]!;
  const runs: Array<{ from: number; to: number; mark: string }> = [];
  if (s.length > 0 && rng() < 0.5) runs.push({ from: 0, to: 1 + Math.floor(rng() * s.length), mark: "bold" });
  if (s.length > 1 && rng() < 0.4) runs.push({ from: Math.floor(rng() * s.length), to: s.length, mark: "italic" });
  return rt(s, runs);
}

export function randomJson(rng: () => number): JsonValue {
  const roll = rng();
  if (roll < 0.3) return Math.floor(rng() * 100);
  if (roll < 0.5) return rng() < 0.5;
  if (roll < 0.7) return ["urgent", "calm", "late"][Math.floor(rng() * 3)]!;
  if (roll < 0.8) return null;
  if (roll < 0.9) return { level: Math.floor(rng() * 4) };
  return [1, "two", false];
}

/**
 * Generate one valid transaction for a peer. The engine mirror validates;
 * locally-invalid ops (e.g. move into own subtree) are skipped. If the
 * adapter ever rejects an op the engine accepted, that error propagates —
 * the harness is also an equivalence fuzz.
 */
export function randomTx(peer: Peer, rng: () => number): Transaction {
  const ids = Object.keys(peer.mirror.blocks);
  const aliveIds = [...liveTree(peer.mirror).alive];
  const deadIds = ids.filter((id) => !aliveIds.includes(id));
  const pick = <T>(arr: readonly T[]): T | undefined =>
    arr.length ? arr[Math.floor(rng() * arr.length)] : undefined;

  for (let attempt = 0; attempt < 10; attempt++) {
    const roll = rng();
    let op: Op | undefined;
    if (roll < 0.2 || ids.length === 0) {
      op = {
        op: "insert",
        block: makeBlock({ type: "nooq.paragraph/v1", text: randomText(rng) }, peer.actor),
        parent: pick(aliveIds) ?? null,
      };
    } else if (roll < 0.4) {
      const id = pick(ids)!;
      op = { op: "setField", block: id, key: "tone", value: randomJson(rng) };
    } else if (roll < 0.55) {
      const id = pick(ids)!;
      op = { op: "textEdit", block: id, replace: randomText(rng) };
    } else if (roll < 0.75) {
      const id = pick(aliveIds);
      if (!id) continue;
      op = { op: "move", block: id, newParent: pick(aliveIds.filter((x) => x !== id)) ?? null, index: Math.floor(rng() * 3) };
    } else if (roll < 0.9) {
      const id = pick(aliveIds);
      if (!id) continue;
      op = { op: "delete", block: id };
    } else {
      const id = pick(deadIds);
      if (!id) continue;
      op = { op: "restore", block: id, parent: pick(aliveIds) ?? null };
    }

    const candidate = txOf([op], peer.lamport + 1, peer.actor);
    try {
      peer.mirror = engineApply(peer.mirror, candidate);
    } catch {
      continue; // invalid in this peer's local view; try another op
    }
    yjsApply(peer.doc, candidate); // adapter disagreement with the engine fails loudly here
    peer.lamport = candidate.lamport;
    return candidate;
  }

  const nop = txOf([], peer.lamport + 1, peer.actor);
  applyToPeer(peer, nop);
  return nop;
}
