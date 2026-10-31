import { describe, expect, test } from "bun:test";
import { canonicalJson, liveTree, replaceChanges, rootDigest, type BlockId, type DocState } from "@nooq/core";
import { normalize, readState } from "../src/index.ts";
import { P1, P2, applyToPeer, makePeers, rt, sync, txOf } from "./helpers.ts";

function parentCountOf(state: DocState, id: BlockId): { count: number; parent: BlockId | null } {
  let count = 0;
  let parent: BlockId | null = null;
  if (state.roots.includes(id)) {
    count++;
    parent = null;
  }
  for (const block of Object.values(state.blocks)) {
    if (block.children.includes(id)) {
      count++;
      parent = block.id;
    }
  }
  return { count, parent };
}

describe("DM-4.7: concurrent moves", () => {
  test("converge to exactly one parent on both peers", async () => {
    const { p1, p2, ids } = makePeers();
    applyToPeer(p1, txOf([{ op: "move", block: ids.p, newParent: ids.section, index: 0 }], 10, P1));
    applyToPeer(p2, txOf([{ op: "move", block: ids.p, newParent: ids.other }], 10, P2));
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    const s2 = readState(p2.doc);
    expect(canonicalJson(s1)).toBe(canonicalJson(s2));

    const a = parentCountOf(s1, ids.p);
    const b = parentCountOf(s2, ids.p);
    expect(a.count).toBe(1);
    expect(b).toEqual(a);
    expect(await rootDigest(s1)).toBe(await rootDigest(s2));

    normalize(p1.doc);
    normalize(p2.doc);
    sync(p1.doc, p2.doc);
    expect(canonicalJson(readState(p1.doc))).toBe(canonicalJson(readState(p2.doc)));
  });

  test("concurrent moves within one parent keep one entry (dedup)", async () => {
    const { p1, p2, ids } = makePeers();
    applyToPeer(p1, txOf([{ op: "move", block: ids.p, newParent: ids.section, index: 0 }], 10, P1));
    // index is post-detach: after p leaves section, [q, h] has length 2; 2 is the end.
    applyToPeer(p2, txOf([{ op: "move", block: ids.p, newParent: ids.section, index: 2 }], 10, P2));
    sync(p1.doc, p2.doc);
    const s1 = readState(p1.doc);
    expect(parentCountOf(s1, ids.p).count).toBe(1);
    expect(canonicalJson(s1)).toBe(canonicalJson(readState(p2.doc)));
  });
});

describe("DM-4.8: edit vs delete", () => {
  test("delete wins placement; concurrent edits persist in the tombstone", async () => {
    const { p1, p2, ids } = makePeers();
    applyToPeer(p1, txOf([{ op: "textEdit", block: ids.p, changes: replaceChanges("hello world", "edited while away") }], 10, P1));
    applyToPeer(p2, txOf([{ op: "delete", block: ids.p }], 10, P2));
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    expect(liveTree(s1).alive.has(ids.p)).toBe(false);
    expect(s1.blocks[ids.p]!.text!.s).toBe("edited while away");
    expect(canonicalJson(s1)).toBe(canonicalJson(readState(p2.doc)));
  });

  test("move vs delete converges; placement register decides deterministically", async () => {
    const { p1, p2, ids } = makePeers();
    applyToPeer(p1, txOf([{ op: "move", block: ids.p, newParent: ids.other }], 10, P1));
    applyToPeer(p2, txOf([{ op: "delete", block: ids.p }], 11, P2));
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    const s2 = readState(p2.doc);
    expect(canonicalJson(s1)).toBe(canonicalJson(s2));
    expect(parentCountOf(s1, ids.p).count).toBeLessThanOrEqual(1);
  });
});

describe("concurrent-move cycles", () => {
  test("cycle members become unreachable (tombstoned), data intact, peers agree", async () => {
    const { p1, p2, ids } = makePeers();
    // Both moves are valid in their local views; merged, they form a cycle.
    applyToPeer(p1, txOf([{ op: "move", block: ids.c, newParent: ids.section }], 10, P1));
    applyToPeer(p2, txOf([{ op: "move", block: ids.section, newParent: ids.c }], 10, P2));
    sync(p1.doc, p2.doc);

    const s1 = readState(p1.doc);
    const s2 = readState(p2.doc);
    expect(canonicalJson(s1)).toBe(canonicalJson(s2));

    const alive = liveTree(s1).alive;
    expect(alive.has(ids.section)).toBe(false);
    expect(alive.has(ids.c)).toBe(false);
    expect(alive.has(ids.other)).toBe(true);
    expect(s1.blocks[ids.section]).toBeDefined();
    expect(s1.blocks[ids.c]).toBeDefined();
    // q, p, h were section's children — orphaned with it.
    expect(alive.has(ids.q)).toBe(false);
    expect(alive.has(ids.p)).toBe(false);

    // Normalization keeps the two peers converged and does not resurrect anything.
    normalize(p1.doc);
    normalize(p2.doc);
    sync(p1.doc, p2.doc);
    const n1 = readState(p1.doc);
    const n2 = readState(p2.doc);
    expect(canonicalJson(n1)).toBe(canonicalJson(n2));
    expect(liveTree(n1).alive.has(ids.section)).toBe(false);
  });
});
