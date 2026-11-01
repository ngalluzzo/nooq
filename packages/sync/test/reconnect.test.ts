/**
 * SYNC Draft 3.1: secured documents reconnect, edits sealed offline are
 * delivered from the outbox (SW-3/SW-4), and the relay logs and relays each
 * update once (SW-6).
 */
import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { createActorKey, createSecuredDocument, makeBlock, newBlockId, toBase64, type Access, type ActorKey, type Op, type Transaction } from "@nooq/core";
import { commitSigned, newDocument, readState } from "@nooq/yjs";
import * as YDoc from "yjs";
import { decodeMessage, encodeMessage, NooqRelay, settled, SyncSession, type SyncTransport, type WireMessage } from "../src/index.ts";
import { rt } from "./rt.ts";

let lamport = 0;
const tx = (ops: Op[], actorId = "human:owner"): Transaction => ({ id: newBlockId(), actor: { actorId, kind: "human" }, lamport: ++lamport, causality: {}, ops });

async function securedDoc() {
  const owner = await createActorKey();
  const party = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(party);
  const access: Access = { owner: party, nonce, grants: [] };
  const doc = newDocument(docId);
  const genesis = await commitSigned(doc, tx([{ op: "setAccess", access }]), owner, "human:owner");
  return { owner, docId, doc, genesis };
}

/** A transport that can drop off the network: sends throw, nothing arrives. */
function flaky(inner: SyncTransport): { transport: SyncTransport; goOffline: () => void } {
  let online = true;
  return {
    transport: {
      send: (raw) => {
        if (!online) throw new Error("offline");
        inner.send(raw);
      },
      onMessage: (handler) => inner.onMessage((raw) => { if (online) handler(raw); }),
      close: () => inner.close(),
    },
    goOffline: () => { online = false; },
  };
}

async function edit(doc: Y.Doc, key: ActorKey, ops: Op[]) {
  return commitSigned(doc, tx(ops), key, "human:owner");
}

describe("secured reconnect and the outbox (SW-3/SW-4, Draft 3.1)", () => {
  test("a secured document reconnects and delivers edits sealed offline", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const errors: string[] = [];
    const link = flaky(relay.connect(docId));
    const session = new SyncSession({ doc, transport: link.transport, actor: "human:owner", onError: (error) => errors.push(error.code) });
    session.start();
    session.sendUpdate(genesis.update, genesis.envelope);
    await settled();
    expect(relay.envelopesOf(docId)).toHaveLength(1);

    link.goOffline();
    const block = makeBlock({ type: "nooq.paragraph/v1", text: rt("") }, "human:owner");
    for (const ops of [
      [{ op: "insert", block, parent: null }],
      [{ op: "textEdit", block: block.id, changes: [{ insert: "written" }] }],
      [{ op: "textEdit", block: block.id, changes: [{ retain: 7 }, { insert: " offline" }] }],
    ] as Op[][]) {
      const sealed = await edit(doc, owner, ops);
      session.sendUpdate(sealed.update, sealed.envelope); // the network is down: no throw, it waits
    }
    expect(session.outbox.length).toBeGreaterThanOrEqual(3);

    session.restart(relay.connect(docId));
    await settled(8);
    expect(errors).toEqual([]); // offline edits are expected, not a verification failure
    expect(session.synced).toBe(true);
    expect(relay.envelopesOf(docId)).toHaveLength(4);
    expect(readState(relay.stored(docId)!).blocks[block.id]!.text!.s).toBe("written offline");

    // The next handshake confirms everything, so the outbox empties.
    session.restart(relay.connect(docId));
    await settled(8);
    expect(session.outbox).toHaveLength(0);
    expect(session.synced).toBe(true);

    // A joiner sees the offline edits, verified through the envelope log.
    const joined = newDocument(docId);
    const joinerErrors: string[] = [];
    new SyncSession({ doc: joined, transport: relay.connect(docId), actor: "human:reader", onError: (error) => joinerErrors.push(error.code) }).start();
    await settled(8);
    expect(joinerErrors).toEqual([]);
    expect(readState(joined).blocks[block.id]!.text!.s).toBe("written offline");
  });

  test("a session restored from a persisted outbox delivers it", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const offline = flaky(relay.connect(docId));
    offline.goOffline();
    const first = new SyncSession({ doc, transport: offline.transport, actor: "human:owner" });
    first.start();
    first.sendUpdate(genesis.update, genesis.envelope);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: rt("kept") }, "human:owner");
    const inserted = await edit(doc, owner, [{ op: "insert", block, parent: null }]);
    first.sendUpdate(inserted.update, inserted.envelope);
    const persisted = first.outbox;
    first.close();
    expect(persisted).toHaveLength(2);

    const errors: string[] = [];
    const second = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner", outbox: persisted, onError: (error) => errors.push(error.code) });
    second.start();
    await settled(8);
    expect(errors).toEqual([]);
    expect(second.synced).toBe(true);
    expect(relay.envelopesOf(docId)).toHaveLength(2);
    expect(readState(relay.stored(docId)!).blocks[block.id]!.text!.s).toBe("kept");
  });
});

describe("the relay logs and relays each update once (SW-6, Draft 3.1)", () => {
  test("retransmissions are not logged twice, and a forged duplicate is denied", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const session = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
    session.start();
    session.sendUpdate(genesis.update, genesis.envelope);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: rt("once") }, "human:owner");
    const inserted = await edit(doc, owner, [{ op: "insert", block, parent: null }]);
    session.sendUpdate(inserted.update, inserted.envelope);
    await settled(8);
    expect(relay.envelopesOf(docId)).toHaveLength(2);

    // An observer connected to the relay counts what gets relayed to it.
    const observer = relay.connect(docId);
    const relayed: string[] = [];
    observer.onMessage((raw) => { const message = JSON.parse(raw); if (message.t === "update") relayed.push(message.envelope?.sig ?? "bare"); });
    observer.send(encodeMessage({ v: 1, t: "hello", doc: docId, backend: "yjs/1", sv: null, update: null }));
    await settled(8);

    const sender = relay.connect(docId);
    const replies: string[] = [];
    sender.onMessage((raw) => replies.push(JSON.parse(raw).code ?? JSON.parse(raw).t));
    const resend = (envelope: typeof inserted.envelope) =>
      sender.send(encodeMessage({ v: 1, t: "update", doc: docId, update: toBase64(inserted.update), envelope }));

    resend(inserted.envelope); // an honest retransmission
    await settled(8);
    expect(relay.envelopesOf(docId)).toHaveLength(2);
    expect(relayed).toEqual([]);
    expect(replies).not.toContain("envelope-denied");

    resend({ ...inserted.envelope, sig: genesis.envelope.sig }); // a forgery over honest bytes
    await settled(8);
    expect(replies).toContain("envelope-denied");
    expect(relay.envelopesOf(docId)).toHaveLength(2);
    expect(relayed).toEqual([]);
  });
});

/** A peer that answers every hello with a reply of its own making. */
function scriptedPeer(reply: (hello: Extract<WireMessage, { t: "hello" }>) => WireMessage[]): SyncTransport {
  let handler: ((raw: string) => void) | undefined;
  return {
    send: (raw) => {
      const message = decodeMessage(raw);
      if (message?.t === "hello") for (const out of reply(message)) queueMicrotask(() => handler?.(encodeMessage(out)));
    },
    onMessage: (h) => (handler = h),
    close: () => (handler = undefined),
  };
}

describe("secured bootstrap verifies before it applies (SW-3, Draft 3.1)", () => {
  test("a delta carrying state its envelope log does not attest is discarded", async () => {
    const { owner, docId, doc, genesis } = await securedDoc();
    const block = makeBlock({ type: "nooq.paragraph/v1", text: rt("unattested") }, "human:owner");
    await edit(doc, owner, [{ op: "insert", block, parent: null }]); // honest bytes, never logged
    const fresh = newDocument(docId);
    const errors: string[] = [];
    const reply = (): WireMessage[] => [{
      v: 1, t: "hello-reply", doc: docId, backend: "yjs/1",
      sv: toBase64(YDoc.encodeStateVector(doc)),
      delta: toBase64(YDoc.encodeStateAsUpdate(doc)), // genesis + the unlogged insert
      rootDigest: null,
      envelopes: [{ envelope: genesis.envelope, update: toBase64(genesis.update) }],
    }];
    const session = new SyncSession({ doc: fresh, transport: scriptedPeer(reply), actor: "human:reader", onError: (error) => errors.push(error.code) });
    session.start();
    await settled(8);
    expect(errors).toEqual(["envelope-log-mismatch"]);
    expect(session.synced).toBe(false);
    expect(readState(fresh).blocks[block.id]).toBeUndefined(); // never applied
  });

  test("a secured document with state but no envelope log is not accepted", async () => {
    const { docId, doc } = await securedDoc();
    const fresh = newDocument(docId);
    const errors: string[] = [];
    const reply = (): WireMessage[] => [{
      v: 1, t: "hello-reply", doc: docId, backend: "yjs/1",
      sv: toBase64(YDoc.encodeStateVector(doc)), delta: toBase64(YDoc.encodeStateAsUpdate(doc)), rootDigest: null,
    }];
    const session = new SyncSession({ doc: fresh, transport: scriptedPeer(reply), actor: "human:reader", onError: (error) => errors.push(error.code) });
    session.start();
    await settled(8);
    expect(errors).toEqual(["envelope-log-mismatch"]);
    expect(readState(fresh).access).toBeUndefined();
  });

  test("a bare delta message in a secured document is refused", async () => {
    const { docId, doc } = await securedDoc();
    const fresh = newDocument(docId);
    const verdicts: string[] = [];
    const reply = (): WireMessage[] => [
      { v: 1, t: "hello-reply", doc: docId, backend: "yjs/1", sv: toBase64(YDoc.encodeStateVector(fresh)), delta: null, rootDigest: null },
      { v: 1, t: "delta", doc: docId, delta: toBase64(YDoc.encodeStateAsUpdate(doc)) },
    ];
    const session = new SyncSession({ doc: fresh, transport: scriptedPeer(reply), actor: "human:reader", onAdmission: (verdict, reason) => verdicts.push(`${verdict}: ${reason}`) });
    session.start();
    await settled(8);
    expect(verdicts).toEqual(["deny: unsigned delta in a secured document"]);
    expect(readState(fresh).access).toBeUndefined();
  });
});
