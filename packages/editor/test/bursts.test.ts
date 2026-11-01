/**
 * Typing bursts (DM-14.3, proposals/0005): signed typing coalesces into one
 * transaction, one update and one envelope per burst. Keystrokes still apply
 * locally at once (EB-6); peers see a burst when it seals.
 */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type ActorKey } from "@nooq/core";
import { commitSigned, newDocument } from "@nooq/yjs";
import { NooqRelay, settled } from "@nooq/sync";
import { Editor, type EditorOptions } from "../src/controller.ts";

async function world() {
  const owner = await createActorKey(), alice = await createActorKey(), bob = await createActorKey();
  const ownerParty = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = { owner: ownerParty, nonce, grants: [
    { actorId: "human:alice", key: toBase64(alice.publicBytes), kind: "human", role: "writer" },
    { actorId: "human:bob", key: toBase64(bob.publicBytes), kind: "human", role: "writer" },
  ] };
  const relay = new NooqRelay();
  const genesis = await commitSigned(newDocument(docId), { id: newBlockId(), actor: { actorId: "human:owner", kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access }] }, owner, "human:owner");
  relay.connect(docId).send(JSON.stringify({ v: 1, t: "update", doc: docId, update: toBase64(genesis.update), envelope: genesis.envelope }));
  await settled(6);
  const editor = (actorId: string, key: ActorKey, burst?: EditorOptions["burst"]) =>
    new Editor({ docId, actor: { actorId }, transport: relay.connect(docId), key, ...(burst !== undefined ? { burst } : {}) });
  return { relay, docId, keys: { alice, bob }, editor };
}

/** Type one character at a time, as the surface does. */
function type(editor: Editor, block: string, text: string, at = editor.view.blocks[block]!.text!.s.length): void {
  for (const [i, ch] of [...text].entries()) editor.applyTextChanges(block, at + i > 0 ? [{ retain: at + i }, { insert: ch }] : [{ insert: ch }]);
}

const typedEnvelopes = (relay: NooqRelay, docId: string) =>
  relay.envelopesOf(docId).filter(({ envelope }) => envelope.tx.intent === "type");

/** Signing and admission run on WebCrypto: wait until the relay's log stops growing. */
async function quiesce(relay: NooqRelay, docId: string): Promise<void> {
  for (let stable = 0, last = -1; stable < 5;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = relay.envelopesOf(docId).length;
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

describe("typing bursts (DM-14.3)", () => {
  test("a typed word is one transaction, one update and one envelope (proposals/0005 gate)", async () => {
    const { relay, docId, keys, editor } = await world();
    const alice = editor("human:alice", keys.alice), bob = editor("human:bob", keys.bob);
    await settled(8);
    const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
    await settled(10);
    const history = alice.history().length;

    type(alice, block, "hello");
    expect(alice.view.blocks[block]!.text!.s).toBe("hello"); // EB-6: applied locally at once
    await settled(10);
    expect(typedEnvelopes(relay, docId)).toHaveLength(0); // still open: nothing shipped
    expect(bob.view.blocks[block]!.text!.s).toBe("");

    alice.flush();
    await settled(10);
    const sealed = typedEnvelopes(relay, docId);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.envelope.tx.ops).toEqual([{ op: "textEdit", block, changes: [{ insert: "hello" }] }]);
    const structs = (Y.decodeUpdate(sealed[0]!.update) as unknown as { structs: Array<{ id: { client: number } }> }).structs;
    expect(new Set(structs.map((struct) => struct.id.client))).toEqual(new Set([sealed[0]!.envelope.client]));
    expect(alice.history().length).toBe(history + 1);
    expect(bob.view.blocks[block]!.text!.s).toBe("hello");
    alice.close(); bob.close();
  });

  test("a word boundary, another action, a caret jump and a peer's edit each seal the burst", async () => {
    const { relay, docId, keys, editor } = await world();
    const alice = editor("human:alice", keys.alice), bob = editor("human:bob", keys.bob);
    await settled(8);
    const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
    await settled(10);
    const changesOf = () => typedEnvelopes(relay, docId).map(({ envelope }) => (envelope.tx.ops[0] as { changes: unknown }).changes);

    type(alice, block, "hi there"); // the space seals "hi "
    await settled(10);
    expect(changesOf()).toEqual([[{ insert: "hi " }]]);

    alice.setField(block, "tone", "warm"); // another action seals "there" first
    await settled(10);
    expect(changesOf().at(-1)).toEqual([{ retain: 3 }, { insert: "there" }]);

    type(alice, block, "A", 0); // a caret jump: typing elsewhere seals
    type(alice, block, "z"); // (a letter: punctuation would seal at once)
    await settled(10);
    expect(changesOf().at(-1)).toEqual([{ insert: "A" }]);

    type(bob, block, "?", 0); // bob edits the block alice is typing in
    bob.flush();
    await settled(12);
    expect(changesOf().at(-1)).toEqual([{ retain: 9 }, { insert: "z" }]); // alice's burst sealed on bob's change
    expect(alice.view.blocks[block]!.text!.s).toBe(bob.view.blocks[block]!.text!.s);
    expect(alice.view.blocks[block]!.text!.s).toBe("?Ahi therez");
    alice.close(); bob.close();
  });

  test("a burst seals when input pauses, and at its maximum duration", async () => {
    const { relay, docId, keys, editor } = await world();
    const alice = editor("human:alice", keys.alice, { idleMs: 20, maxMs: 60 });
    await settled(8);
    const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
    await settled(10);
    type(alice, block, "abc");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settled(10);
    expect(typedEnvelopes(relay, docId)).toHaveLength(1); // idle

    for (let i = 0; i < 10; i++) {
      type(alice, block, "x"); // never idle for 20 ms
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    alice.flush();
    await settled(10);
    expect(typedEnvelopes(relay, docId).length).toBeGreaterThanOrEqual(3); // the 60 ms cap split it
    alice.close();
  });

  test("the caret rides its burst: peers get it when the burst seals, not once per keystroke (SW-7)", async () => {
    const { relay, docId, keys, editor } = await world();
    const alice = editor("human:alice", keys.alice), bob = editor("human:bob", keys.bob);
    await settled(8);
    const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
    await quiesce(relay, docId);
    type(alice, block, "hello");
    alice.setCursor({ block, offset: 5 }); // where typing left it: the burst stays open
    await settled(10);
    expect(bob.awareness.get("human:alice")).toBeUndefined();

    alice.flush();
    await quiesce(relay, docId); await settled(10);
    expect(bob.awareness.get("human:alice")?.cursor).toEqual({ block, offset: 5 });
    expect(bob.view.blocks[block]!.text!.s).toBe("hello");

    alice.setCursor({ block, offset: 1, anchor: { block, offset: 4 } }); // a selection is not typing: it goes at once
    await settled(10);
    expect(bob.awareness.get("human:alice")?.cursor).toEqual({ block, offset: 1, anchor: { block, offset: 4 } });
    alice.close(); bob.close();
  });

  test("envelopes per typed character fall about fivefold on prose", async () => {
    const prose = "the quick brown fox jumps over the lazy dog and keeps on running";
    const count = async (burst: EditorOptions["burst"]) => {
      const { relay, docId, keys, editor } = await world();
      const alice = editor("human:alice", keys.alice, burst);
      await settled(8);
      const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
      await settled(10);
      type(alice, block, prose);
      alice.flush();
      await quiesce(relay, docId);
      const text = alice.view.blocks[block]!.text!.s;
      alice.close();
      return { envelopes: typedEnvelopes(relay, docId).length, text };
    };
    const each = await count(false), coalesced = await count(undefined);
    expect(coalesced.text).toBe(prose);
    expect(each.envelopes).toBe(prose.length);
    console.log(`envelopes per typed character: ${(each.envelopes / prose.length).toFixed(2)} → ${(coalesced.envelopes / prose.length).toFixed(2)}`);
    expect(each.envelopes / coalesced.envelopes).toBeGreaterThanOrEqual(4.5);
  }, 30_000);
});
