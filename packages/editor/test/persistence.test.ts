/**
 * Host persistence (DM-14.6): an editor reopened from what its host
 * persisted (stored document, outbox, history) resumes exactly where it
 * stopped, offline edits included, and the stored state verifies against the
 * envelopes the host kept.
 */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Envelope, type Transaction } from "@nooq/core";
import { commitSigned, newDocument, verifyStoredDocument, type LogEntry, type StoredDocument } from "@nooq/yjs";
import { NooqRelay, settled, type OutboxEntry, type SyncTransport } from "@nooq/sync";
import { Editor } from "../src/controller.ts";

/** A transport that can drop off the network: sends throw, nothing arrives. */
function flaky(inner: SyncTransport): { transport: SyncTransport; goOffline: () => void } {
  let online = true;
  return {
    transport: {
      send: (raw) => { if (!online) throw new Error("offline"); inner.send(raw); },
      onMessage: (handler) => inner.onMessage((raw) => { if (online) handler(raw); }),
      close: () => inner.close(),
    },
    goOffline: () => { online = false; },
  };
}

async function quiesce(relay: NooqRelay, docId: string): Promise<void> {
  for (let stable = 0, last = -1; stable < 5;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = relay.envelopesOf(docId).length;
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

describe("host persistence (DM-14.6)", () => {
  test("an editor reopened from its persisted parts resumes, offline edits included", async () => {
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

    // The host: what it persists beside the document.
    const kept = new Map<string, LogEntry>();
    const history: Transaction[] = [];
    const host = {
      onEnvelope: ({ envelope, update }: { envelope: Envelope; update: Uint8Array }) => { kept.set(envelope.updateDigest, { envelope, update }); },
      onHistory: (tx: Transaction) => { history.push(tx); },
    };

    const link = flaky(relay.connect(docId));
    const first = new Editor({ docId, actor: { actorId: "human:alice" }, key: alice, transport: link.transport, ...host });
    await settled(10);
    const block = first.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "online " });
    await quiesce(relay, docId);
    link.goOffline();
    first.applyTextChanges(block, [{ retain: 7 }, { insert: "offline" }]);
    first.flush();
    await new Promise((resolve) => setTimeout(resolve, 30)); // the envelope seals; the send fails
    const stored: StoredDocument = first.store();
    const outbox: ReadonlyArray<OutboxEntry> = first.outbox;
    expect(outbox.length).toBeGreaterThan(0);
    first.close();

    // At rest: the stored state is exactly what the kept envelopes attest.
    expect((await verifyStoredDocument(stored, { envelopes: kept.values() })).ok).toBe(true);
    expect(relay.envelopesOf(docId).some(({ envelope }) => envelope.tx.intent === "type")).toBe(false);

    const errors: string[] = [];
    const reopened = new Editor({ docId, actor: { actorId: "human:alice" }, key: alice, transport: relay.connect(docId), stored, outbox, history, onError: (error) => errors.push(String(error.cause)) });
    expect(reopened.view.blocks[block]!.text!.s).toBe("online offline"); // before any network
    expect(reopened.history()).toEqual(history);
    await quiesce(relay, docId);
    expect(errors).toEqual([]);
    expect(reopened.synced).toBe(true);
    expect(relay.envelopesOf(docId).filter(({ envelope }) => envelope.tx.intent === "type")).toHaveLength(1); // the offline edit, delivered
    reopened.reconnect(relay.connect(docId)); // SW-4: the next handshake confirms it
    await quiesce(relay, docId);
    expect(reopened.outbox).toHaveLength(0);

    const peer = new Editor({ docId, actor: { actorId: "human:bob" }, key: bob, transport: relay.connect(docId) });
    await quiesce(relay, docId);
    expect(peer.view.blocks[block]!.text!.s).toBe("online offline");
    reopened.close(); peer.close();
  }, 30_000);

  test("a stored document for another document is refused", () => {
    expect(() => new Editor({ docId: "doc-a", actor: { actorId: "human:alice" }, stored: { docId: "doc-b", schemaVersion: 1, state: new Uint8Array([0, 0]) } })).toThrow("is not doc-a");
  });
});
