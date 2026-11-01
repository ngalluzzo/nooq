import "./dom.ts";
import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  createActorKey,
  makeBlock,
  toBase64,
  type Access,
} from "@nooq/core";
import { readState } from "@nooq/yjs";
import { commitSigned, newDocument } from "@nooq/yjs";
import { createSecuredDocument, newBlockId } from "@nooq/core";
import { NooqRelay, settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const DOC = "signed-editor-doc";

async function keySet() {
  const owner = await createActorKey();
  const alice = await createActorKey();
  const bob = await createActorKey();
  const ai = await createActorKey();
  const ownerParty = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = {
    owner: ownerParty,
    nonce,
    grants: [
      { actorId: "human:alice", key: toBase64(alice.publicBytes), kind: "human", role: "writer" },
      { actorId: "human:bob", key: toBase64(bob.publicBytes), kind: "human", role: "writer" },
      { actorId: "ai:reference", key: toBase64(ai.publicBytes), kind: "ai", role: "suggester" },
    ],
  };
  return { owner, alice, bob, ai, access, docId };
}

function signedEditor(
  relay: NooqRelay,
  keys: Awaited<ReturnType<typeof keySet>>,
  who: "owner" | "alice" | "bob",
): Editor {
  const actorId = who === "owner" ? "human:owner" : who === "alice" ? "human:alice" : "human:bob";
  const key = who === "owner" ? keys.owner : who === "alice" ? keys.alice : keys.bob;
  return new Editor({
    docId: keys.docId,
    actor: { actorId, name: who },
    transport: relay.connect(keys.docId),
    key,
    aiKey: keys.ai, // the simulated model plugin ships with every editor
  });
}

/** Genesis + grants: the owner's single access lineage, shipped once. */
async function openForBusiness(relay: NooqRelay, keys: Awaited<ReturnType<typeof keySet>>): Promise<void> {
  const ownerDoc = newDocument(keys.docId);
  const genesisTx: import("@nooq/core").Transaction = {
    id: newBlockId(),
    actor: { actorId: "human:owner", kind: "human" },
    lamport: 1,
    causality: {},
    ops: [{ op: "setAccess", access: keys.access }],
  };
  const committed = await commitSigned(ownerDoc, genesisTx, keys.owner, "human:owner");
  const transport = relay.connect(keys.docId);
  const replies: string[] = [];
  transport.onMessage((raw) => replies.push(raw));
  transport.send(JSON.stringify({ v: 1, t: "update", doc: keys.docId, update: Buffer.from(committed.update).toString("base64"), envelope: committed.envelope }));
  await settled(6);
}

describe("signed editors through a hosted peer (B4, DM-12/13 over the wire)", () => {
  test("typed text flows as sealed envelopes and converges", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);

    const owner = signedEditor(relay, keys, "owner");
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();

    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "typed on alice" });
    await settled();

    expect(canonicalJson(readState(alice.ydoc))).toBe(canonicalJson(readState(bob.ydoc)));
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("typed on alice");
    // Every shipped update is in the relay's envelope log (SW-3).
    expect(relay.envelopesOf(keys.docId).length).toBeGreaterThan(0);

    owner.close();
    alice.close();
    bob.close();
  });

  test("a hostile unsigned update is dropped by the relay; peers never see it", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const owner = signedEditor(relay, keys, "owner");
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();
    const before = canonicalJson(readState(bob.ydoc));

    // An attacker with a raw transport sends a bare update into a signed doc.
    const hostileTransport = relay.connect(keys.docId);
    // The relay must refuse a bare update regardless of content: unsigned
    // state cannot bypass the rules of a secured document.
    hostileTransport.send(
      JSON.stringify({ v: 1, t: "update", doc: keys.docId, update: Buffer.from("garbage-but-irrelevant").toString("base64") }),
    );
    await settled();

    expect(canonicalJson(readState(bob.ydoc))).toBe(before);
    expect(canonicalJson(readState(alice.ydoc))).toBe(before);

    owner.close();
    alice.close();
    bob.close();
  });

  test("an AI suggestion ships sealed; overreach dies at the relay (SW-6)", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const owner = signedEditor(relay, keys, "owner");
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();

    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "make this shine" });
    await settled();

    // The simulated model plugin (running on alice's editor) proposes.
    const suggestionId = await alice.propose({
      ops: [{ op: "textEdit", block: paragraph, changes: [{ insert: "Make this shine" }] }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settled(10);
    // The suggestion reached bob as a sealed suggester envelope.
    expect(readState(bob.ydoc).blocks[suggestionId]).toBeDefined();

    const before = canonicalJson(readState(bob.ydoc));
    const aiTx = {
      id: crypto.randomUUID(),
      actor: { actorId: "ai:reference", kind: "ai" as const, model: "simulated/1" },
      lamport: 99,
      causality: {},
      ops: [{ op: "textEdit", block: paragraph, changes: [{ insert: "hijacked" }] }] as import("@nooq/core").Op[],
    } satisfies import("@nooq/core").Transaction as import("@nooq/core").Transaction;
    // Route through alice's signed path: applyCaptured applies locally,
    // the ship seals with the AI key, the relay must deny it.
    const { applyCaptured, sealEnvelope } = await import("@nooq/yjs");
    const captured = applyCaptured(alice.ydoc, aiTx, keys.ai, "ai:reference")!;
    const sealed = await sealEnvelope(alice.ydoc, aiTx, captured.update, keys.ai, "ai:reference");
    // Send through a raw transport as if a hostile client emitted it.
    const attacker = relay.connect(keys.docId);
    attacker.send(JSON.stringify({ v: 1, t: "update", doc: keys.docId, update: Buffer.from(captured.update).toString("base64"), envelope: sealed }));
    await settled(10);

    expect(canonicalJson(readState(bob.ydoc))).toBe(before);
    // Alice's local doc applied it (local-first), but the relay refused to
    // store or forward it — the split is the price of local application
    // before admission; bob's state is what the rules protect.
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("make this shine");

    owner.close();
    alice.close();
    bob.close();
  }, 30_000);

  test("an adoption over the wire keeps AI text attributed on every peer (DM-14.2, proposals/0005)", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();
    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "make this shine" });
    await settled(10);
    const suggestion = await alice.propose({
      ops: [{ op: "textEdit", block: paragraph, changes: [{ delete: 1 }, { insert: "M" }] }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settled(10);
    await bob.accept(suggestion);
    await settled(10);

    const owner = signedEditor(relay, keys, "owner"); // joins after the fact, verifies the log
    await settled(10);
    expect(owner.synced).toBe(true);
    const adopted = { actorId: "ai:reference", kind: "ai" as const, model: "simulated/1", adoptedBy: "human:bob", characters: 1 };
    for (const peer of [alice, bob, owner]) {
      expect(peer.view.blocks[paragraph]!.text!.s).toBe("Make this shine");
      expect(peer.authorsOf(paragraph)).toEqual([adopted, { actorId: "human:alice", kind: "human" as const, characters: 14 }]);
      expect(peer.settledBy(suggestion)).toBe("human:bob");
    }
    expect(relay.envelopesOf(keys.docId).some(({ envelope }) => envelope.tx.adoptedBy === "human:bob")).toBe(true);
    // History lives outside state: alice heard the adoption, the joiner replayed it (DM-14.4).
    for (const peer of [alice, owner]) expect(peer.history().filter((tx) => tx.adoptedBy === "human:bob")).toHaveLength(1);
    expect(owner.view.blocks[suggestion]!.fields.proposal).toMatchObject({ intent: "rewrite-block" });
    alice.close();
    bob.close();
    owner.close();
  }, 30_000);

  test("a fresh signed peer bootstraps through the verified envelope log", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const owner = signedEditor(relay, keys, "owner");
    const alice = signedEditor(relay, keys, "alice");
    await settled();
    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "before bob joined" });
    await settled();

    const bob = signedEditor(relay, keys, "bob");
    await settled(8);
    expect(bob.synced).toBe(true);
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("before bob joined");
    expect(readState(bob.ydoc).access?.owner.actorId).toBe("human:owner");

    owner.close();
    alice.close();
    bob.close();
  }, 30_000);
});
