import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createActorKey, createSecuredDocument, makeBlock, newBlockId, toBase64, type Access, type ActorKey, type Op, type Transaction } from "@nooq/core";
import { commitSigned, newDocument } from "@nooq/yjs";
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

/** Draft 3.3 (SW-6, proposals/0011): holds bounded by age and count; eviction changes no verdict. */
describe("bounded holds (DM-10.7, proposals/0011)", () => {
  test("an ungranted writer holds; age eviction is observable; the re-offer admits after the grant", async () => {
    const relay = new NooqRelay();
    const { owner, docId, doc, genesis } = await securedDoc();
    // The owner seeds the relay first: without the genesis base everything holds.
    const seeder = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
    seeder.start();
    seeder.sendUpdate(genesis.update, genesis.envelope);
    await settled();
    expect(relay.envelopesOf(docId).length).toBe(1);
    seeder.close();
    const writer = await createActorKey();
    const writerDoc = newDocument(docId);
    Y.applyUpdate(writerDoc, genesis.update);

    // Writer edits BEFORE being granted: the relay holds the envelope (SW-6).
    const wops: Op[] = [{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1", text: rt("early") }, "human:writer"), parent: null }];
    const wtx = await commitSigned(writerDoc, tx(wops, "human:writer"), writer, "human:writer");
    const wSession = new SyncSession({ doc: writerDoc, transport: relay.connect(docId), actor: "human:writer" });
    wSession.start();
    wSession.sendUpdate(wtx.update, wtx.envelope);
    await settled();
    expect(relay.envelopesOf(docId).some(e => e.envelope.updateDigest === wtx.envelope.updateDigest)).toBeFalse();
    expect(relay.heldCount(docId)).toBe(1); // held, observable

    // Age eviction (deterministic seam): bound 0ms, everything is aged.
    const agedBefore = relay.evictionCounters().age;
    relay.evictAllAged(docId, 0);
    expect(relay.heldCount(docId)).toBe(0);
    expect(relay.evictionCounters().age).toBeGreaterThan(agedBefore); // never silent

    // Grant the writer, then RE-OFFER the same bytes: the ordinary path admits.
    const ownerDoc = newDocument(docId);
    Y.applyUpdate(ownerDoc, genesis.update);
    const prior = (await import("@nooq/yjs")).readState(ownerDoc).access as Access;
    const grant = await commitSigned(ownerDoc, tx([{ op: "setAccess", access: { ...prior, grants: [...prior.grants, { actorId: "human:writer", key: toBase64(writer.publicBytes), kind: "human", role: "writer" }] } }]), owner, "human:owner");
    const oSession = new SyncSession({ doc: ownerDoc, transport: relay.connect(docId), actor: "human:owner" });
    oSession.start();
    oSession.sendUpdate(grant.update, grant.envelope);
    await settled();
        wSession.sendUpdate(wtx.update, wtx.envelope); // the re-offer
    await settled();
    expect(relay.envelopesOf(docId).some(e => e.envelope.updateDigest === wtx.envelope.updateDigest)).toBeTrue();
    wSession.close(); oSession.close();
  });

  test("a flood past the count bound evicts oldest; admitted envelopes unaffected; eviction counted", () => {
    const relay = new NooqRelay();
    const { docId } = { docId: "nooq:sha256:flood" } as const;
    const before = relay.evictionCounters().count;
    relay.floodHolds(docId, 1_100);
    expect(relay.heldCount(docId)).toBe(1_024);
    expect(relay.evictionCounters().count).toBeGreaterThanOrEqual(before + 76);
  });
});
