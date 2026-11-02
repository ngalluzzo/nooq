import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createActorKey, createSecuredDocument, makeBlock, newBlockId, toBase64, type Access, type ActorKey, type Op, type Role, type Transaction } from "@nooq/core";
import { commitSigned, newDocument, readState } from "@nooq/yjs";
import { NooqRelay, settled, SyncSession } from "../src/index.ts";
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

async function grantTo(ownerDoc: Y.Doc, owner: ActorKey, current: Access, actorId: string, key: string, role: Role = "writer"): Promise<{ update: Uint8Array; envelope: Awaited<ReturnType<typeof commitSigned>>["envelope"] }> {
  const grants = [...current.grants.filter(g => (g.epoch ?? 0) === (current.epoch ?? 0)), { actorId, key, kind: "human" as const, role, epoch: current.epoch ?? 0 }];
  const next = { ...current, grants };
  const committed = await commitSigned(ownerDoc, tx([{ op: "setAccess", access: next }]), owner, "human:owner");
  return { update: committed.update, envelope: committed.envelope };
}

async function rotate(ownerDoc: Y.Doc, owner: ActorKey, current: Access, { revoke = [] as string[], regrant = [] as Array<{ actorId: string; key: string; role?: Role }> }) {
  const epoch = (current.epoch ?? 0) + 1;
  const survivors = current.grants.filter(g => (g.epoch ?? 0) === (current.epoch ?? 0) && !revoke.includes(g.actorId));
  const kept = survivors.map(g => ({ ...g, epoch }));
  const added = regrant.map(({ actorId, key, role }) => ({ actorId, key, kind: "human" as const, role: (role ?? "writer") as "writer", epoch }));
  const revoked: string[] = [...(current.revoked ?? []), ...revoke];
  const next: Access = { ...current, epoch, grants: [...kept, ...added], revoked };
  const committed = await commitSigned(ownerDoc, tx([{ op: "setAccess", access: next }]), owner, "human:owner");
  return { update: committed.update, envelope: committed.envelope };
}

async function writerEdit(writerDoc: Y.Doc, writer: ActorKey, text: string) {
  return commitSigned(writerDoc, tx([{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1", text: rt(text) }, "human:writer"), parent: null }], "human:writer"), writer, "human:writer");
}

/** DM-13.6 (proposals/0012) across the real session/relay wire. */
describe("revocation across the wire (DM-13.6, proposals/0012)", () => {
  test("grant admits; rotation revokes; the same writer's next envelope is dropped by the relay", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const ownerSession = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
    ownerSession.start();
    ownerSession.sendUpdate(genesis.update, genesis.envelope);
    await settled();

    // Grant a writer; their edit relays.
    const writer = await createActorKey();
    const writerDoc = newDocument(docId);
    Y.applyUpdate(writerDoc, Y.encodeStateAsUpdate(doc));
    const grant = await grantTo(doc, owner, readState(doc).access!, "human:writer", toBase64(writer.publicBytes));
    ownerSession.sendUpdate(grant.update, grant.envelope);
    await settled();
    const first = await writerEdit(writerDoc, writer, "hello");
    const wSession = new SyncSession({ doc: writerDoc, transport: relay.connect(docId), actor: "human:writer" });
    wSession.start();
    wSession.sendUpdate(first.update, first.envelope);
    await settled();
    expect(relay.envelopesOf(docId).some(e => e.envelope.updateDigest === first.envelope.updateDigest)).toBeTrue();

    // Rotate: revoke the writer. The same machinery — one owner-signed tx.
    const rotation = await rotate(doc, owner, readState(doc).access!, { revoke: ["human:writer"] });
    ownerSession.sendUpdate(rotation.update, rotation.envelope);
    await settled();

    // The writer's next envelope is DENIED on the wire: dropped, not held, not relayed.
    const second = await writerEdit(writerDoc, writer, "goodbye");
    wSession.sendUpdate(second.update, second.envelope);
    await settled();
    expect(relay.envelopesOf(docId).some(e => e.envelope.updateDigest === second.envelope.updateDigest)).toBeFalse();
    expect(relay.heldCount(docId)).toBe(0); // denied, never held
    expect(readState(doc).access?.revoked).toEqual(["human:writer"]);
    wSession.close(); ownerSession.close();
  });

  test("re-grant at a later epoch un-revokes across the wire", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const ownerSession = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
    ownerSession.start();
    ownerSession.sendUpdate(genesis.update, genesis.envelope);
    await settled();

    const writer = await createActorKey();
    const writerDoc = newDocument(docId);
    Y.applyUpdate(writerDoc, Y.encodeStateAsUpdate(doc));
    const g1 = await grantTo(doc, owner, readState(doc).access!, "human:writer", toBase64(writer.publicBytes));
    ownerSession.sendUpdate(g1.update, g1.envelope);
    await settled();
    const revoke = await rotate(doc, owner, readState(doc).access!, { revoke: ["human:writer"] });
    ownerSession.sendUpdate(revoke.update, revoke.envelope);
    await settled();

    // Un-revoke: epoch+2, writer re-listed; the roll keeps them (append-only).
    const wSession = new SyncSession({ doc: writerDoc, transport: relay.connect(docId), actor: "human:writer" });
    wSession.start();
    const back = await rotate(doc, owner, readState(doc).access!, { regrant: [{ actorId: "human:writer", key: toBase64(writer.publicBytes) }] });
    ownerSession.sendUpdate(back.update, back.envelope);
    await settled();
    const third = await writerEdit(writerDoc, writer, "back again");
    wSession.sendUpdate(third.update, third.envelope);
    await settled();
    expect(relay.envelopesOf(docId).some(e => e.envelope.updateDigest === third.envelope.updateDigest)).toBeTrue();
    expect(readState(doc).access?.revoked).toEqual(["human:writer"]); // roll is history, grant is present tense
    wSession.close(); ownerSession.close();
  });

  test("eventual, per device at sync time: a peer that missed the rotation admits the write; it is never rolled back", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    const ownerSession = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
    ownerSession.start();
    ownerSession.sendUpdate(genesis.update, genesis.envelope);
    await settled();

    const writer = await createActorKey();
    const writerDoc = newDocument(docId);
    Y.applyUpdate(writerDoc, Y.encodeStateAsUpdate(doc));
    const g1 = await grantTo(doc, owner, readState(doc).access!, "human:writer", toBase64(writer.publicBytes));
    ownerSession.sendUpdate(g1.update, g1.envelope);
    await settled();

    // A LAGGING PEER: synced through the grant, then disconnected.
    const laggingDoc = newDocument(docId);
    Y.applyUpdate(laggingDoc, Y.encodeStateAsUpdate(doc));
    const lagging = new SyncSession({ doc: laggingDoc, transport: relay.connect(docId), actor: "human:lag", onError: () => {} });
    lagging.start();
    await settled();
    (lagging as unknown as { transport: { close(): void } }).transport.close();

    // Owner rotates (revoking the writer); the relay and owner know; the lagging peer does not.
    const revoke = await rotate(doc, owner, readState(doc).access!, { revoke: ["human:writer"] });
    ownerSession.sendUpdate(revoke.update, revoke.envelope);
    await settled();

    // The lagging peer still holds the PRE-rotation access (its own admit
    // path, proven at core level): authorize(laggingAccess, writer) allows.
    const laggingAccess = readState(laggingDoc).access!;
    const { roleOf } = await import("@nooq/core");
    const laggingGrant = laggingAccess.grants.find(g => g.actorId === "human:writer")!;
    expect(roleOf(laggingAccess, "human:writer", laggingGrant.key)).toBe("writer"); // current THERE
    expect(laggingAccess.epoch ?? 0).toBe(0);
    // And the authoritative state denies:
    expect(readState(doc).access?.revoked).toEqual(["human:writer"]);
    ownerSession.close();
    void lagging;
  });
});
