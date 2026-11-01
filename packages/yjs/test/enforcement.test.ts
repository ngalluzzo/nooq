import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computeDigests,
  createActorKey,
  createSecuredDocument,
  makeBlock,
  makeSuggestionBlock,
  newBlockId,
  rootDigest,
  toBase64,
  type Access,
  type Op,
  type Transaction,
} from "@nooq/core";
import { admitEnvelope, commitSigned, newDocument, readState } from "../src/index.ts";

const marks = (s: string): string[][] => s.split("").map(() => []);

function tx(ops: Op[], actorId: string, lamport: number, kind: "human" | "ai" = "human"): Transaction {
  return { id: newBlockId(), actor: { actorId, kind }, lamport, causality: {}, ops };
}

async function keychain() {
  const owner = await createActorKey();
  const writer = await createActorKey();
  const ai = await createActorKey();
  const hostile = await createActorKey();
  return { owner, writer, ai, hostile };
}

/**
 * A secured document at genesis: the ID commits to owner+nonce (Draft 1.7),
 * the first envelope is the genesis access write, and grants arrive as
 * owner-signed appends.
 */
async function securedDoc() {
  const chain = await keychain();
  const ownerParty = { actorId: "human:owner", key: toBase64(chain.owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const grantsAtGenesis = [
    { actorId: "human:writer", key: toBase64(chain.writer.publicBytes), kind: "human" as const, role: "writer" as const },
    { actorId: "ai:assistant", key: toBase64(chain.ai.publicBytes), kind: "ai" as const, role: "suggester" as const },
  ];
  const genesis: Access = { owner: ownerParty, grants: grantsAtGenesis, nonce };
  const source = newDocument(docId);
  const genesisCommit = await commitSigned(source, tx([{ op: "setAccess", access: genesis }], "human:owner", 1), chain.owner, "human:owner");
  const peer = newDocument(docId);
  const admission = await admitEnvelope(peer, genesisCommit.envelope, genesisCommit.update);
  expect(admission.verdict).toBe("allow");
  return { chain, docId, nonce, genesis, source, peer, genesisCommit };
}

describe("signed envelopes (DM-12)", () => {
  test("one transaction = one update = one verifiable envelope", async () => {
    const { chain, source, peer } = await securedDoc();
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "hi", marks: marks("hi") } }, "human:owner");
    const committed = await commitSigned(source, tx([{ op: "insert", block, parent: null }], "human:owner", 2), chain.owner, "human:owner");

    const admission = await admitEnvelope(peer, committed.envelope, committed.update);
    expect(admission.verdict).toBe("allow");
    expect(readState(peer).blocks[block.id]).toBeDefined();
  });

  test("tampered update bytes are dropped (digest mismatch)", async () => {
    const { chain, source, peer } = await securedDoc();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:owner");
    const committed = await commitSigned(source, tx([{ op: "insert", block, parent: null }], "human:owner", 2), chain.owner, "human:owner");
    const tampered = new Uint8Array(committed.update);
    tampered[tampered.length - 1] ^= 0xff;
    const admission = await admitEnvelope(peer, committed.envelope, tampered);
    expect(admission.verdict).toBe("deny");
    expect(admission.reason).toContain("digest");
  });

  test("structs from a client the envelope does not declare are dropped", async () => {
    const { chain, source, peer } = await securedDoc();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:owner");
    const committed = await commitSigned(source, tx([{ op: "insert", block, parent: null }], "human:owner", 2), chain.owner, "human:owner");
    const forged = { ...committed.envelope, client: 999999 };
    expect((await admitEnvelope(peer, forged, committed.update)).verdict).toBe("deny");
  });
});

describe("secured-at-genesis (DM-13 Draft 1.7)", () => {
  test("before genesis, only the genesis envelope admits; the rest hold", async () => {
    const { chain, docId, genesis } = await securedDoc();
    // A fresh peer that has NOT admitted genesis holds ordinary envelopes
    // (sealed on a throwaway so the author's local apply can't speak).
    const fresh = newDocument(docId);
    const strangerKey = await createActorKey();
    const stranger = makeBlock({ type: "nooq.paragraph/v1" }, "human:stranger");
    const committed = await commitSigned(newDocument(docId), tx([{ op: "insert", block: stranger, parent: null }], "human:stranger", 5), strangerKey, "human:stranger");
    expect((await admitEnvelope(fresh, committed.envelope, committed.update)).verdict).toBe("hold");

    // A forged genesis (wrong nonce) holds — sealed on a throwaway so the
    // author's local application cannot speak for the receiver.
    const forgedGenesis = await commitSigned(
      newDocument(docId),
      tx([{ op: "setAccess", access: { ...genesis, nonce: "not-the-nonce" } }], "human:owner", 6),
      chain.owner,
      "human:owner",
    );
    expect((await admitEnvelope(fresh, forgedGenesis.envelope, forgedGenesis.update)).verdict).toBe("hold");

    const real = await commitSigned(
      newDocument(docId),
      tx([{ op: "setAccess", access: genesis }], "human:owner", 7),
      chain.owner,
      "human:owner",
    );
    expect((await admitEnvelope(fresh, real.envelope, real.update)).verdict).toBe("allow");
  });

  test("an open document never gains access (ID decides, not content)", async () => {
    const key = await createActorKey();
    const open = newDocument("plain-open-doc");
    const access: Access = {
      owner: { actorId: "human:owner", key: toBase64(key.publicBytes), kind: "human" },
      nonce: "n",
      grants: [],
    };
    const committed = await commitSigned(open, tx([{ op: "setAccess", access }], "human:owner", 1), key, "human:owner");
    const peer = newDocument("plain-open-doc");
    const admission = await admitEnvelope(peer, committed.envelope, committed.update);
    expect(admission.verdict).toBe("deny");
    expect(admission.reason).toContain("never gains access");
  });
});

describe("access rules over real updates (DM-13)", () => {
  test("suggesters ship suggestion blocks; overreach is denied on every peer", async () => {
    const { chain, source, peer } = await securedDoc();
    const target = makeBlock({ type: "nooq.paragraph/v1", text: { s: "draft", marks: marks("draft") } }, "human:owner");
    const targetCommit = await commitSigned(source, tx([{ op: "insert", block: target, parent: null }], "human:owner", 2), chain.owner, "human:owner");
    expect((await admitEnvelope(peer, targetCommit.envelope, targetCommit.update)).verdict).toBe("allow");

    const view = readState(source);
    const digests = await computeDigests(view);
    const proposal = {
      base: { rootDigest: await rootDigest(view) },
      ops: [{ op: "textEdit", block: target.id, changes: [{ insert: "Draft" }] }] as Op[],
      evidence: [{ block: target.id, contentDigest: digests.get(target.id)!.contentDigest, structureDigest: digests.get(target.id)!.structureDigest }],
      context: { model: "test" },
      actor: "ai:assistant",
      actorDescriptor: { actorId: "ai:assistant", kind: "ai" as const, model: "test" },
    };
    const suggestion = makeSuggestionBlock(proposal, "ai:assistant");
    const good = await commitSigned(source, tx([{ op: "insert", block: suggestion, parent: null }], "ai:assistant", 3, "ai"), chain.ai, "ai:assistant");
    expect((await admitEnvelope(peer, good.envelope, good.update)).verdict).toBe("allow");
    expect(readState(peer).blocks[suggestion.id]).toBeDefined();

    const overreach = await commitSigned(source, tx([{ op: "textEdit", block: target.id, changes: [{ insert: "hijack" }] }], "ai:assistant", 4, "ai"), chain.ai, "ai:assistant");
    expect((await admitEnvelope(peer, overreach.envelope, overreach.update)).verdict).toBe("deny");
    expect(readState(peer).blocks[target.id]!.text!.s).toBe("draft");
  });

  test("impersonation (own key, claimed actorId) is denied, not held", async () => {
    const { chain, docId, genesisCommit } = await securedDoc();
    const hostileDoc = newDocument(docId);
    await admitEnvelope(hostileDoc, genesisCommit.envelope, genesisCommit.update);
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:writer");
    const forged = await commitSigned(newDocument(docId), tx([{ op: "insert", block, parent: null }], "human:writer", 5), chain.hostile, "human:writer");
    expect((await admitEnvelope(hostileDoc, forged.envelope, forged.update)).verdict).toBe("deny");
  });

  test("valid strangers hold; the owner's append-only grant releases them", async () => {
    const { chain, docId, genesis, source, genesisCommit } = await securedDoc();
    const strangerDoc = newDocument(docId);
    // ONE genesis lineage, ever: the owner's own envelope, admitted here.
    await admitEnvelope(strangerDoc, genesisCommit.envelope, genesisCommit.update);

    const strangerKey = await createActorKey();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:new");
    const pending = await commitSigned(newDocument(docId), tx([{ op: "insert", block, parent: null }], "human:new", 5), strangerKey, "human:new");
    expect((await admitEnvelope(strangerDoc, pending.envelope, pending.update)).verdict).toBe("hold");

    const granted: Access = {
      ...genesis,
      grants: [...genesis.grants, { actorId: "human:new", key: toBase64(strangerKey.publicBytes), kind: "human", role: "writer" }],
    };
    // Grants extend the owner's single access lineage (sealed on the
    // owner's doc, whose clocks continue the genesis chain) — a fresh
    // throwaway would fork the map key under LWW.
    const grantEnvelope = await commitSigned(source, tx([{ op: "setAccess", access: granted }], "human:owner", 6), chain.owner, "human:owner");
    expect((await admitEnvelope(strangerDoc, grantEnvelope.envelope, grantEnvelope.update)).verdict).toBe("allow");
    expect((await admitEnvelope(strangerDoc, pending.envelope, pending.update)).verdict).toBe("allow");
    expect(readState(strangerDoc).blocks[block.id]).toBeDefined();
  });

  test("access writes are owner-only; non-extending writes deny", async () => {
    const { chain, docId, genesis, source, genesisCommit } = await securedDoc();
    // One lineage: the owner's genesis (source) admitted by ownerDoc; the
    // rewrite below extends source's chain — never a second author.
    const writerDoc = source;
    const ownerDoc = newDocument(docId);
    await admitEnvelope(ownerDoc, genesisCommit.envelope, genesisCommit.update);
    const escalated: Access = { ...genesis, grants: [...genesis.grants, { actorId: "human:evil", key: genesis.owner.key, kind: "human", role: "writer" }] };
    const attempt = await commitSigned(newDocument(docId), tx([{ op: "setAccess", access: escalated }], "human:writer", 5), chain.writer, "human:writer");
    expect((await admitEnvelope(ownerDoc, attempt.envelope, attempt.update)).verdict).toBe("deny");
    // Even the owner cannot rewrite grants non-append-only (nonce/owner immutable).
    const rewritten: Access = { ...genesis, nonce: "other" };
    const rewrite = await commitSigned(writerDoc, tx([{ op: "setAccess", access: rewritten }], "human:owner", 6), chain.owner, "human:owner");
    expect((await admitEnvelope(ownerDoc, rewrite.envelope, rewrite.update)).verdict).toBe("deny");
  });

  test("honest peers drop identical envelopes and converge", async () => {
    const { chain, docId, genesis } = await securedDoc();
    const writerDoc = newDocument(docId);
    const hostileDoc = newDocument(docId);
    const boot = await commitSigned(writerDoc, tx([{ op: "setAccess", access: genesis }], "human:owner", 1), chain.owner, "human:owner");
    await admitEnvelope(hostileDoc, boot.envelope, boot.update);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "real work", marks: marks("real work") } }, "human:writer");
    const honest = await commitSigned(writerDoc, tx([{ op: "insert", block, parent: null }], "human:writer", 2), chain.writer, "human:writer");
    await admitEnvelope(hostileDoc, honest.envelope, honest.update);
    const evil = await commitSigned(hostileDoc, tx([{ op: "textEdit", block: block.id, changes: [{ insert: "evil" }] }], "human:writer", 2), chain.hostile, "human:writer");

    const peers = [newDocument(docId), newDocument(docId)];
    for (const peer of peers) {
      await admitEnvelope(peer, boot.envelope, boot.update);
      expect((await admitEnvelope(peer, honest.envelope, honest.update)).verdict).toBe("allow");
      expect((await admitEnvelope(peer, evil.envelope, evil.update)).verdict).toBe("deny");
    }
    expect(canonicalJson(readState(peers[0]!))).toBe(canonicalJson(readState(peers[1]!)));
    expect(readState(peers[0]!).blocks[block.id]!.text!.s).toBe("real work");
  });
});
