import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, makeBlock, newBlockId, type Op, type Transaction } from "@nooq/core";
import { applyTransaction as applyToDoc, newDocument, readState } from "../src/index.ts";
import { MaintainedProjection } from "../src/projection.ts";

const marks = (s: string): string[][] => s.split("").map(() => []);
const tx = (ops: Op[], actorId = "human:t", lamport = 1): Transaction => ({
  id: newBlockId(), actor: { actorId, kind: "human" }, lamport, causality: {}, ops,
});

/** The oracle: maintained === pure readState, canonically, right now. */
function agrees(doc: Y.Doc, projection: MaintainedProjection): boolean {
  projection.sync();
  return canonicalJson(projection.value) === canonicalJson(readState(doc));
}

function seeded(name: Parameters<typeof makeBlock>[0] extends never ? never : string) {
  void name;
}

describe("MaintainedProjection (EB-6 stage 2)", () => {
  test("agrees through every operation kind, applied one by one", () => {
    const doc = newDocument("projection-ops");
    const projection = new MaintainedProjection(doc);
    const a = makeBlock({ type: "nooq.paragraph/v1", text: { s: "alpha", marks: marks("alpha") } }, "human:t");
    const b = makeBlock({ type: "nooq.section/v1" }, "human:t");
    const c = makeBlock({ type: "nooq.heading/v1", text: { s: "child", marks: marks("child") } }, "human:t");

    const ops: Op[][] = [
      [{ op: "insert", block: a, parent: null }],
      [{ op: "textEdit", block: a.id, changes: [{ retain: 5 }, { insert: " text" }] }],
      [{ op: "insert", block: b, parent: null }],
      [{ op: "insert", block: c, parent: b.id }],
      [{ op: "setField", block: a.id, key: "tone", value: "warm" }],
      [{ op: "move", block: a.id, newParent: b.id }],
      [{ op: "delete", block: c.id }],
      [{ op: "restore", block: c.id, parent: null }],
      [{ op: "move", block: a.id, newParent: null }],
      [{ op: "textEdit", block: a.id, changes: [{ delete: 5 }] }],
    ];
    for (const batch of ops) {
      applyToDoc(doc, tx(batch));
      expect(agrees(doc, projection)).toBeTrue();
    }
    projection.destroy();
  });

  test("agrees when changes arrive as REMOTE updates (the sync path)", () => {
    const local = newDocument("projection-remote");
    const peer = newDocument("projection-remote");
    const projection = new MaintainedProjection(local);

    // seed both from the same base
    const base = makeBlock({ type: "nooq.paragraph/v1", text: { s: "base", marks: marks("base") } }, "human:t");
    applyToDoc(peer, tx([{ op: "insert", block: base, parent: null }]));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));

    // remote edits arrive as merged updates, out of order across two peers
    const p2 = newDocument("projection-remote");
    Y.applyUpdate(p2, Y.encodeStateAsUpdate(local));
    const extra = makeBlock({ type: "nooq.paragraph/v1", text: { s: "extra", marks: marks("extra") } }, "human:t2");
    applyToDoc(peer, tx([{ op: "textEdit", block: base.id, changes: [{ insert: "X" }] }], "human:t", 2));
    applyToDoc(p2, tx([{ op: "insert", block: extra, parent: null }], "human:t3", 3));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));
    expect(agrees(local, projection)).toBeTrue();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(p2));
    expect(agrees(local, projection)).toBeTrue();

    // and a concurrent delete/restore race merging in one update
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
    applyToDoc(peer, tx([{ op: "delete", block: extra.id }], "human:t", 4));
    applyToDoc(p2, tx([{ op: "move", block: base.id, newParent: null }], "human:t3", 5));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(p2));
    expect(agrees(local, projection)).toBeTrue();
    projection.destroy();
  });

  test("agrees across a seeded op storm (the convergence-oracle pattern)", () => {
    const doc = newDocument("projection-storm");
    const projection = new MaintainedProjection(doc);
    let lamport = 0;
    const ids: string[] = [];
    let rng = 0x5eed;
    const next = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let round = 0; round < 120; round++) {
      const roll = next();
      const ops: Op[] = [];
      if (roll < 0.25 || ids.length === 0) {
        const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "t" + round, marks: marks("t" + round) } }, "human:t");
        ops.push({ op: "insert", block, parent: ids.length && next() < 0.3 ? ids[0]! : null });
      } else {
        const target = ids[Math.floor(next() * ids.length)]!;
        if (roll < 0.5) ops.push({ op: "textEdit", block: target, changes: [{ insert: "x" }] });
        else if (roll < 0.65) ops.push({ op: "setField", block: target, key: "k", value: round });
        else if (roll < 0.8) ops.push({ op: "delete", block: target });
        else ops.push({ op: "move", block: target, newParent: next() < 0.5 ? null : ids[0] ?? null });
      }
      try { applyToDoc(doc, tx(ops, "human:t", ++lamport)); } catch { /* invalid against current view; skip */ }
      if (round % 12 === 0) expect(agrees(doc, projection)).toBeTrue();
    }
    expect(agrees(doc, projection)).toBeTrue();
    expect(Object.keys(projection.value.blocks).length).toBeGreaterThan(20);
    projection.destroy();
  });

  test("serves a projection that satisfies core invariants unchanged (digests/liveness)", async () => {
    const doc = newDocument("projection-core");
    const projection = new MaintainedProjection(doc);
    const block = makeBlock({ type: "nooq.section/v1" }, "human:t");
    const child = makeBlock({ type: "nooq.paragraph/v1", text: { s: "in", marks: marks("in") } }, "human:t");
    applyToDoc(doc, tx([{ op: "insert", block, parent: null }, { op: "insert", block: child, parent: block.id }]));
    projection.sync();
    const { computeDigests, rootDigest, liveTree } = await import("@nooq/core");
    const view = projection.value;
    expect(() => rootDigest(view as never)).not.toThrow();
    expect(liveTree(view as never).alive.has(child.id)).toBeTrue();
    expect(await computeDigests(view as never)).toBeTruthy();
    void seeded;
    projection.destroy();
  });
});
