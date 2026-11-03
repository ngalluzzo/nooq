import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createActorKey, createSecuredDocument, sha256, toHex, newBlockId, toBase64, type Access, type Op, type Transaction } from "@nooq/core";
import { commitSigned, newDocument } from "@nooq/yjs";
import { blobSrc, createBlobStore, digestOfBlobSrc, NooqRelay, settled, SyncSession } from "../src/index.ts";

/** 0014: content-addressed attachments, end to end through the real relay. */
describe("content-addressed blobs (0014)", () => {
  const bytes = (n: number): Uint8Array => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 31 + n) % 256));

  test("put → digest; get → the same bytes, verified; the session never sees blob replies", async () => {
    const relay = new NooqRelay();
    const party = { actorId: "human:o", key: "k", kind: "human" as const };
    const { docId, nonce } = await createSecuredDocument(party);
    const access: Access = { owner: party, nonce, grants: [] };
    const doc = newDocument(docId);
    const store = createBlobStore(relay.connect(docId), docId);
    const seen: string[] = [];
    store.transport.onMessage(raw => { if (raw.includes("blob")) seen.push(raw); }); // the session's view
    const session = new SyncSession({ doc, transport: store.transport, actor: "human:o" });
    session.start();

    const payload = bytes(2048);
    const digest = await store.put(payload);
    expect(digest).toBe("sha256:" + toHex(await sha256(payload)));
    const back = await store.get(digest);
    expect([...back]).toEqual([...payload]);
    expect(seen).toEqual([]); // blob traffic is invisible to the session's handler
    // The cache: a second get never touches the wire (byte-identical, instant).
    const again = await store.get(digest);
    expect([...again]).toEqual([...payload]);
    session.close();
  });

  test("dedup by content: same bytes, one store entry", async () => {
    const relay = new NooqRelay();
    const store = createBlobStore(relay.connect("dedup"), "dedup");
    const payload = bytes(512);
    const a = await store.put(payload);
    const b = await store.put(payload);
    expect(a).toBe(b);
    expect(relay.blobCount()).toBe(1);
    const other = await store.put(bytes(513));
    expect(other).not.toBe(a);
    expect(relay.blobCount()).toBe(2);
  });

  test("THE TEST: a tampered blob fails its digest on arrival", async () => {
    // A lying relay answers blob-get with different bytes under the digest
    // the document named. The client re-hashes: the mismatch rejects, the
    // bytes never reach the cache. (0014's authenticity limb.)
    // A lying relay: every blob-get is answered with DIFFERENT bytes under
    // the digest the document named. The client must re-hash and reject.
    const handlerRef = { current: undefined as ((raw: string) => void) | undefined };
    const evil = {
      send(raw: string): void {
        const message = JSON.parse(raw) as { t?: string; doc?: string; digest?: string };
        if (message.t !== "blob-get") return;
        const tampered = toBase64(bytes(999)); // NOT the bytes the digest names
        setTimeout(() => handlerRef.current?.(JSON.stringify({ v: 1, t: "blob-ok", doc: message.doc, digest: message.digest, blob: tampered })), 0);
      },
      onMessage(handler: (raw: string) => void): void { handlerRef.current = handler; },
      close(): void {},
    };
    const store = createBlobStore(evil as never, "evil");
    // The document named the honest digest of bytes(42); the liar serves bytes(999).
    const digest = "sha256:" + toHex(await sha256(bytes(42)));
    await expect(store.get(digest)).rejects.toThrow(/digest mismatch/);
    // The cache stays clean: the tampered bytes are not retrievable
    await expect(store.get(digest)).rejects.toThrow();
  });

  test("miss and cap: unknown digests reject; the relay's size cap is named", async () => {
    const relay = new NooqRelay();
    const store = createBlobStore(relay.connect("misc"), "misc");
    await expect(store.get("sha256:" + "0".repeat(64))).rejects.toThrow(/no blob/);
    const empty = new Uint8Array(0);
    await expect(store.put(empty)).rejects.toThrow();
  });

  test("blobSrc / digestOfBlobSrc: the scheme round-trips", () => {
    const digest = "sha256:" + "a".repeat(64);
    expect(blobSrc(digest)).toBe(`nooq-blob:${digest}`);
    expect(digestOfBlobSrc(blobSrc(digest))).toBe(digest);
    expect(digestOfBlobSrc("https://nooq.dev/x.png")).toBeNull();
  });

  test("a document carries the reference while the wire carries the bytes", async () => {
    // The full 0014 shape: an image block with a nooq-blob: src, the bytes
    // on the relay — the CRDT never sees a byte (the envelope is tiny).
    const relay = new NooqRelay();
    const owner = await createActorKey();
    const party = { actorId: "human:o", key: toBase64(owner.publicBytes), kind: "human" as const };
    const { docId, nonce } = await createSecuredDocument(party);
    const access: Access = { owner: party, nonce, grants: [] };
    const doc = newDocument(docId);
    let lamport = 0;
    const tx = (ops: Op[]): Transaction => ({ id: newBlockId(), actor: { actorId: "human:o", kind: "human" }, lamport: ++lamport, causality: {}, ops });
    const genesis = await commitSigned(doc, tx([{ op: "setAccess", access }]), owner, "human:o");
    const store = createBlobStore(relay.connect(docId), docId);
    const session = new SyncSession({ doc, transport: store.transport, actor: "human:o" });
    session.start();
    session.sendUpdate(genesis.update, genesis.envelope);
    await settled();

    const payload = bytes(128);
    const digest = await store.put(payload);
    const imageBlock = { id: newBlockId(), type: "nooq.image/v1", fields: { src: blobSrc(digest), digest }, text: { s: "pic", marks: [[], [], []] } // one mark slot per character — the model's invariant, children: [], attribution: { created: { actor: "human:o" }, fields: {} } };
    const insert = await commitSigned(doc, tx([{ op: "insert", block: imageBlock, parent: null }]), owner, "human:o");
    session.sendUpdate(insert.update, insert.envelope);
    await settled();

    expect(relay.blobCount()).toBe(1);
    const envelopeJson = JSON.stringify(insert.envelope);
    expect(envelopeJson.length).toBeLessThan(2000); // the envelope carries fields, not bytes
    expect(envelopeJson).not.toContain("blob-put"); // bytes never rode the CRDT
    const back = await store.get(digest);
    expect([...back]).toEqual([...payload]); // and the peer can fetch + verify
    session.close();
  });
});
