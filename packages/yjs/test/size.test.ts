/**
 * Live-state size gates (DM-14.1, proposals/0005).
 *
 * The reference random workload: one block, 5,000 seeded random single-
 * character inserts and deletes, one nooq transaction each, GC off. Raw Yjs
 * costs ~10 B per edit on it; live state may cost at most 16 B per edit and
 * holds no intent log.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { makeBlock, newBlockId, type Op, type Transaction } from "@nooq/core";
import { applyTransaction, newDocument, readState } from "../src/index.ts";

const EDITS = 5000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The workload as (position, insert?) steps, identical for raw Yjs and nooq. */
function workload(seed: number): Array<{ at: number; insert: string | null }> {
  const rng = mulberry32(seed);
  const steps: Array<{ at: number; insert: string | null }> = [];
  let length = 0;
  for (let i = 0; i < EDITS; i++) {
    const insert = length === 0 || rng() < 0.6;
    const at = Math.floor(rng() * (insert ? length + 1 : length));
    steps.push({ at, insert: insert ? "abcdefghij klmnop"[Math.floor(rng() * 17)]! : null });
    length += insert ? 1 : -1;
  }
  return steps;
}

describe("live state stays lean (DM-14.1, proposals/0005)", () => {
  test("≤ 16 B per edit on the reference random workload, with no intent log", () => {
    const steps = workload(5005);

    const raw = new Y.Doc({ gc: false });
    const rawText = raw.getText("t");
    for (const step of steps) raw.transact(() => (step.insert ? rawText.insert(step.at, step.insert) : rawText.delete(step.at, 1)));

    let lamport = 0;
    const tx = (ops: Op[]): Transaction => ({ id: newBlockId(), actor: { actorId: "human:alice", kind: "human" }, lamport: ++lamport, causality: {}, ops });
    const doc = newDocument("size-doc");
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "", marks: [] } }, "human:alice");
    applyTransaction(doc, tx([{ op: "insert", block, parent: null }]));
    for (const step of steps) {
      const change = step.insert ? { insert: step.insert } : { delete: 1 };
      applyTransaction(doc, tx([{ op: "textEdit", block: block.id, changes: [{ retain: step.at }, change] }]));
    }

    expect(readState(doc).blocks[block.id]!.text!.s).toBe(rawText.toString());
    const nooqPerEdit = Y.encodeStateAsUpdate(doc).length / EDITS;
    const rawPerEdit = Y.encodeStateAsUpdate(raw).length / EDITS;
    console.log(`random workload: nooq ${nooqPerEdit.toFixed(1)} B/edit, raw Yjs ${rawPerEdit.toFixed(1)} B/edit`);
    expect(nooqPerEdit).toBeLessThanOrEqual(16);
    expect([...doc.share.keys()]).not.toContain("log"); // no replicated intent log
    expect(doc.getMap("clients").size).toBe(1); // one client, registered once
  });
});
