/**
 * Secured peers converge byte for byte (DM-12, SW-5).
 *
 * Yjs cleans up redundant formatting after REMOTE text changes in a local
 * transaction of its own. In a secured document that cleanup can never
 * replicate (it is unsigned), so peers that ran it diverged: different
 * delete sets, different encodings, and sometimes different text. nooq
 * documents turn the cleanup off (newDocument), so every peer holds exactly
 * the signed updates, in any delivery order.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  canonicalJson,
  createActorKey,
  createSecuredDocument,
  makeBlock,
  newBlockId,
  toBase64,
  type Access,
  type ActorKey,
  type Envelope,
  type Op,
  type TextChange,
  type Transaction,
} from "@nooq/core";
import { admitEnvelope, applyCaptured, newDocument, readState, sealEnvelope } from "../src/index.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKS = ["bold", "italic", "code"];

interface Peer {
  actorId: string;
  key: ActorKey;
  doc: Y.Doc;
  lamport: number;
  inbox: Array<{ envelope: Envelope; update: Uint8Array }>;
  held: Array<{ envelope: Envelope; update: Uint8Array }>;
}

const txOf = (peer: Peer, ops: Op[]): Transaction =>
  ({ id: newBlockId(), actor: { actorId: peer.actorId, kind: "human" }, lamport: ++peer.lamport, causality: {}, ops });

async function admit(peer: Peer, item: { envelope: Envelope; update: Uint8Array }): Promise<void> {
  const admission = await admitEnvelope(peer.doc, item.envelope, item.update);
  if (admission.verdict === "deny") throw new Error(`denied: ${admission.reason}`);
  if (admission.verdict === "hold") {
    peer.held.push(item);
    return;
  }
  // Retry held envelopes until none admits (their dependencies may have arrived).
  for (let progress = true; progress;) {
    progress = false;
    for (const waiting of [...peer.held]) {
      const retry = await admitEnvelope(peer.doc, waiting.envelope, waiting.update);
      if (retry.verdict === "allow") {
        peer.held.splice(peer.held.indexOf(waiting), 1);
        progress = true;
      }
    }
  }
}

function randomEdit(rng: () => number, length: number): TextChange[] {
  const roll = rng();
  const at = Math.floor(rng() * (length + 1));
  const marks = MARKS.filter(() => rng() < 0.35);
  if (roll < 0.45 || length === 0) {
    const insert = "abc de".slice(0, 1 + Math.floor(rng() * 5));
    return [{ retain: at }, rng() < 0.3 ? { insert } : { insert, marks }];
  }
  const span = Math.max(1, Math.min(length - Math.min(at, length - 1), 1 + Math.floor(rng() * 6)));
  const from = Math.min(at, length - span);
  if (roll < 0.7) return [{ retain: from }, { delete: span }];
  return [{ retain: from }, { retain: span, setMarks: rng() < 0.2 ? null : marks }];
}

async function storm(seed: number) {
  const rng = mulberry32(seed);
  const keys = [await createActorKey(), await createActorKey(), await createActorKey()];
  const ids = ["human:owner", "human:alice", "human:bob"];
  const party = (i: number) => ({ actorId: ids[i]!, key: toBase64(keys[i]!.publicBytes), kind: "human" as const });
  const { docId, nonce } = await createSecuredDocument(party(0));
  const peers: Peer[] = ids.map((actorId, i) => ({ actorId, key: keys[i]!, doc: newDocument(docId), lamport: 0, inbox: [], held: [] }));
  const log: Array<{ envelope: Envelope; update: Uint8Array }> = [];

  const commit = async (peer: Peer, ops: Op[]) => {
    const captured = applyCaptured(peer.doc, txOf(peer, ops), peer.key, peer.actorId);
    if (!captured) return; // a no-op edit (marks already set): nothing to replicate
    const sealed = { update: captured.update, envelope: await sealEnvelope(peer.doc, captured.tx, captured.update, peer.key, peer.actorId, captured.client) };
    log.push(sealed);
    for (const other of peers) if (other !== peer) other.inbox.push(sealed);
  };
  const deliverAll = async () => {
    for (const peer of peers) {
      while (peer.inbox.length > 0) await admit(peer, peer.inbox.splice(Math.floor(rng() * peer.inbox.length), 1)[0]!);
    }
  };

  const owner = peers[0]!;
  const access: Access = { owner: party(0), nonce, grants: [1, 2].map((i) => ({ ...party(i), role: "writer" as const })) };
  await commit(owner, [{ op: "setAccess", access }]);
  const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "hello world", marks: Array.from({ length: 11 }, (_, i) => (i < 5 ? ["bold"] : [])) } }, owner.actorId);
  await commit(owner, [{ op: "insert", block, parent: null }]);
  await deliverAll();

  for (let step = 0; step < 40; step++) {
    const peer = peers[Math.floor(rng() * peers.length)]!;
    const length = readState(peer.doc).blocks[block.id]!.text!.s.length;
    await commit(peer, [{ op: "textEdit", block: block.id, changes: randomEdit(rng, length) }]);
    // Random partial delivery: concurrent edits interleave with remote ones.
    for (let n = Math.floor(rng() * 3); n > 0; n--) {
      const target = peers[Math.floor(rng() * peers.length)]!;
      if (target.inbox.length > 0) await admit(target, target.inbox.splice(Math.floor(rng() * target.inbox.length), 1)[0]!);
    }
  }
  await deliverAll();

  const joiner: Peer = { actorId: "human:joiner", key: keys[0]!, doc: newDocument(docId), lamport: 0, inbox: [], held: [] };
  for (const item of log) await admit(joiner, item);
  return { peers: [...peers, joiner], blockId: block.id };
}

describe("secured peers converge byte for byte (DM-12, SW-5)", () => {
  test("random concurrent marks and deletes, random delivery, and a fresh joiner", async () => {
    const diverged: number[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      const { peers } = await storm(seed);
      for (const peer of peers) expect(peer.held).toEqual([]);
      const encodings = new Set(peers.map((peer) => toBase64(Y.encodeStateAsUpdate(peer.doc))));
      const projections = new Set(peers.map((peer) => canonicalJson(readState(peer.doc))));
      if (encodings.size !== 1 || projections.size !== 1) diverged.push(seed);
    }
    expect(diverged).toEqual([]);
  }, 60_000);

  test("Yjs still emits afterTransaction before its formatting cleanup (the hook newDocument relies on)", () => {
    // If a Yjs upgrade reorders these, the cleanup runs before nooq can cancel it.
    const a = new Y.Doc({ gc: false });
    const b = new Y.Doc({ gc: false });
    a.getText("t").insert(0, "hello world");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getText("t").format(0, 5, { bold: true });
    b.getText("t").format(2, 6, { bold: true }); // concurrent, overlapping formats
    const localTransactionsAfterRemote = (doc: Y.Doc) => {
      doc.getText("t");
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(a));
      let local = 0;
      doc.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.local) local++;
      });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(b), "remote");
      return local;
    };
    expect(localTransactionsAfterRemote(new Y.Doc({ gc: false }))).toBe(1); // plain Yjs cleans up
    expect(localTransactionsAfterRemote(newDocument("open-doc"))).toBe(0); // a nooq document does not
  });
});

describe("the genesis is authorized like every envelope (DM-13)", () => {
  test("a genesis that also writes outside the document's roots is denied", async () => {
    const { applyTransaction } = await import("../src/index.ts");
    const key = await createActorKey();
    const owner = { actorId: "human:owner", key: toBase64(key.publicBytes), kind: "human" as const };
    const { docId, nonce } = await createSecuredDocument(owner);
    const tx: Transaction = { id: newBlockId(), actor: { actorId: owner.actorId, kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access: { owner, nonce, grants: [] } }] };
    const author = newDocument(docId);
    let update: Uint8Array | undefined;
    author.on("update", (bytes: Uint8Array) => (update = bytes));
    author.transact(() => {
      applyTransaction(author, tx);
      author.getMap("junk").set("smuggled", true); // rides along in the same update
    });
    const envelope = await sealEnvelope(author, tx, update!, key, owner.actorId);
    const receiver = newDocument(docId);
    const admission = await admitEnvelope(receiver, envelope, update!);
    expect(admission.verdict).toBe("deny");
    expect(receiver.getMap("junk").size).toBe(0);
  });
});
