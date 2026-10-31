import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, makeBlock, newBlockId, type Transaction } from "@nooq/core";
import { applyTransaction, newDocument, readState } from "@nooq/yjs";
import { NooqRelay, SyncSession, settled } from "../src/index.ts";

const DOC = "incremental-doc";

function tx(ops: Transaction["ops"], lamport: number, actor: string): Transaction {
  return { id: newBlockId(), actor: { actorId: actor, kind: "human" }, lamport, causality: {}, ops };
}

describe("incremental exchange (SYNC Draft 1.2)", () => {
  test("a first-transaction increment integrates into a fresh doc (the 15-line repro)", async () => {
    // Root cause regression: the header used to consume clocks 0-1, so the
    // insert's items started at clock 2 and fresh peers pended the whole
    // update forever. Real content now starts at clock 0.
    const source = newDocument(DOC);
    const events: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => events.push(update));
    const block = makeBlock(
      { type: "nooq.paragraph/v1", text: { s: "hi", marks: [[], []] } },
      "human:a",
    );
    applyTransaction(source, tx([{ op: "insert", block, parent: null }], 1, "human:a"));

    expect(events).toHaveLength(1);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, events[0]!);
    const projected = readState(fresh);
    expect(projected.blocks[block.id]).toBeDefined();
    expect(projected.blocks[block.id]!.text!.s).toBe("hi");
  });

  test("two fresh peers converge bidirectionally on first contact", async () => {
    // The relay never rebroadcast a joiner's base, so the FIRST peer never
    // learned the SECOND peer's clock 0..n — exactly one direction of an
    // insert exchange silently vanished. Hello updates are relayed now.
    const relay = new NooqRelay();
    const aliceDoc = newDocument(DOC);
    const bobDoc = newDocument(DOC);
    const alice = new SyncSession({ doc: aliceDoc, transport: relay.connect(DOC), actor: "human:alice" });
    const bob = new SyncSession({ doc: bobDoc, transport: relay.connect(DOC), actor: "human:bob" });
    alice.start();
    bob.start();
    await settled();

    const fromAlice = makeBlock({ type: "nooq.paragraph/v1", text: { s: "from alice", marks: "from alice".split("").map(() => []) } }, "human:alice");
    applyTransaction(aliceDoc, tx([{ op: "insert", block: fromAlice, parent: null }], 1, "human:alice"));
    const fromBob = makeBlock({ type: "nooq.paragraph/v1", text: { s: "from bob", marks: "from bob".split("").map(() => []) } }, "human:bob");
    applyTransaction(bobDoc, tx([{ op: "insert", block: fromBob, parent: null }], 1, "human:bob"));
    await settled();

    expect(canonicalJson(readState(aliceDoc))).toBe(canonicalJson(readState(bobDoc)));
    expect(readState(aliceDoc).blocks[fromBob.id]).toBeDefined();
    expect(readState(bobDoc).blocks[fromAlice.id]).toBeDefined();

    alice.close();
    bob.close();
  });

  test("an increment that arrives before its base pends, then integrates (SW-4)", async () => {
    const source = newDocument(DOC);
    const first = makeBlock({ type: "nooq.paragraph/v1" }, "human:a");
    applyTransaction(source, tx([{ op: "insert", block: first, parent: null }], 1, "human:a"));
    const base = Y.encodeStateAsUpdate(source);
    const events: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => events.push(update));
    applyTransaction(source, tx([{ op: "textEdit", block: first.id, changes: [{ insert: "typed" }] }], 2, "human:a"));
    expect(events).toHaveLength(1);

    // Out of order: the increment lands before the base.
    const dst = new Y.Doc();
    Y.applyUpdate(dst, events[0]!);
    expect(readState(dst).blocks[first.id]?.text?.s ?? "").toBe(""); // pended, not lost

    Y.applyUpdate(dst, base); // the base releases the pending struct
    expect(readState(dst).blocks[first.id]!.text!.s).toBe("typed");
  });
});
