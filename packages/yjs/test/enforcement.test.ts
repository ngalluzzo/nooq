import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computeDigests,
  createActorKey,
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

const DOC = "secure-doc";

function marks(s: string): string[][] {
  return s.split("").map(() => []);
}

function tx(ops: Op[], actorId: string, lamport: number, kind: "human" | "ai" = "human"): Transaction {
  return { id: newBlockId(), actor: { actorId, kind }, lamport, causality: {}, ops };
}

async function keychain() {
  const owner = await createActorKey();
  const writer = await createActorKey();
  const ai = await createActorKey();
  const hostile = await createActorKey();
  const access: Access = {
    owner: { actorId: "human:owner", key: toBase64(owner.publicBytes) },
    grants: [
      { actorId: "human:writer", key: toBase64(writer.publicBytes), role: "writer" },
      { actorId: "ai:assistant", key: toBase64(ai.publicBytes), role: "suggester" },
    ],
  };
  return { owner, writer, ai, hostile, access };
}

/** A document with access installed, plus an envelope-carrying peer. */
async function securedDoc() {
  const chain = await keychain();
  const source = newDocument(DOC);
  const bootstrap = await commitSigned(source, tx([{ op: "setAccess", access: chain.access }], "human:owner", 1), chain.owner, "human:owner");
  const peer = newDocument(DOC);
  const boot = await admitEnvelope(peer, bootstrap.envelope, bootstrap.update);
  expect(boot.verdict).toBe("allow");
  return { chain, source, peer };
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
    const committed = await commitSigned(source, tx([], "human:owner", 2), chain.owner, "human:owner");
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

describe("access rules over real updates (DM-13)", () => {
  test("suggesters ship suggestion blocks; overreach is denied on every peer", async () => {
    const { chain, source, peer } = await securedDoc();
    const target = makeBlock({ type: "nooq.paragraph/v1", text: { s: "draft", marks: marks("draft") } }, "human:owner");
    const targetCommit = await commitSigned(source, tx([{ op: "insert", block: target, parent: null }], "human:owner", 2), chain.owner, "human:owner");
    // Peers admit prerequisites before later envelopes reference them
    // (or pend-until-base, which the converge test exercises separately).
    expect((await admitEnvelope(peer, targetCommit.envelope, targetCommit.update)).verdict).toBe("allow");

    const view = readState(source);
    const digests = await computeDigests(view);
    const proposal = {
      base: { rootDigest: await rootDigest(view) },
      ops: [{ op: "textEdit", block: target.id, changes: [{ insert: "Draft" }] }] as Op[],
      evidence: [{ block: target.id, contentDigest: digests.get(target.id)!.contentDigest, structureDigest: digests.get(target.id)!.structureDigest }],
      context: { model: "test" },
      actor: "ai:assistant",
    };
    const suggestion = makeSuggestionBlock(proposal, "ai:assistant");
    const good = await commitSigned(source, tx([{ op: "insert", block: suggestion, parent: null }], "ai:assistant", 3, "ai"), chain.ai, "ai:assistant");
    expect((await admitEnvelope(peer, good.envelope, good.update)).verdict).toBe("allow");
    expect(readState(peer).blocks[suggestion.id]).toBeDefined();

    const overreach = await commitSigned(source, tx([{ op: "textEdit", block: target.id, changes: [{ insert: "hijack" }] }], "ai:assistant", 4, "ai"), chain.ai, "ai:assistant");
    expect((await admitEnvelope(peer, overreach.envelope, overreach.update)).verdict).toBe("deny");
    expect((await admitEnvelope(source, overreach.envelope, overreach.update)).verdict).toBe("deny");
    expect(readState(peer).blocks[target.id]!.text!.s).toBe("draft");
  });

  test("impersonation (own key, claimed actorId) is denied, not held", async () => {
    const { chain } = await securedDoc();
    const hostileDoc = newDocument(DOC);
    const boot = await commitSigned(hostileDoc, tx([{ op: "setAccess", access: chain.access }], "human:owner", 1), chain.owner, "human:owner");
    await admitEnvelope(hostileDoc, boot.envelope, boot.update);
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:writer");
    const forged = await commitSigned(hostileDoc, tx([{ op: "insert", block, parent: null }], "human:writer", 5), chain.hostile, "human:writer");
    expect((await admitEnvelope(hostileDoc, forged.envelope, forged.update)).verdict).toBe("deny");
  });

  test("valid strangers hold pending grants; the grant releases them", async () => {
    const { chain } = await securedDoc();
    const strangerDoc = newDocument(DOC);
    const boot = await commitSigned(strangerDoc, tx([{ op: "setAccess", access: chain.access }], "human:owner", 1), chain.owner, "human:owner");
    await admitEnvelope(strangerDoc, boot.envelope, boot.update);

    const strangerKey = await createActorKey();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:new");
    const pending = await commitSigned(strangerDoc, tx([{ op: "insert", block, parent: null }], "human:new", 5), strangerKey, "human:new");
    expect((await admitEnvelope(strangerDoc, pending.envelope, pending.update)).verdict).toBe("hold");

    const granted: Access = { owner: chain.access.owner, grants: [...chain.access.grants, { actorId: "human:new", key: toBase64(strangerKey.publicBytes), role: "writer" }] };
    const grantEnvelope = await commitSigned(strangerDoc, tx([{ op: "setAccess", access: granted }], "human:owner", 6), chain.owner, "human:owner");
    expect((await admitEnvelope(strangerDoc, grantEnvelope.envelope, grantEnvelope.update)).verdict).toBe("allow");
    expect((await admitEnvelope(strangerDoc, pending.envelope, pending.update)).verdict).toBe("allow");
    expect(readState(strangerDoc).blocks[block.id]).toBeDefined();
  });

  test("access writes are owner-only", async () => {
    const { chain } = await securedDoc();
    const writerDoc = newDocument(DOC);
    const boot = await commitSigned(writerDoc, tx([{ op: "setAccess", access: chain.access }], "human:owner", 1), chain.owner, "human:owner");
    await admitEnvelope(writerDoc, boot.envelope, boot.update);
    const escalated: Access = { owner: chain.access.owner, grants: [...chain.access.grants, { actorId: "human:evil", key: chain.access.owner.key, role: "writer" }] };
    const attempt = await commitSigned(writerDoc, tx([{ op: "setAccess", access: escalated }], "human:writer", 5), chain.writer, "human:writer");
    expect((await admitEnvelope(writerDoc, attempt.envelope, attempt.update)).verdict).toBe("deny");
  });

  test("honest peers drop identical envelopes and converge", async () => {
    const { chain } = await securedDoc();
    const writerDoc = newDocument(DOC);
    const hostileDoc = newDocument(DOC);
    // One shared base: the writer doc's bootstrap, admitted by everyone else
    // (their own bootstraps would leave the writer's client clocks unknown).
    const boot = await commitSigned(writerDoc, tx([{ op: "setAccess", access: chain.access }], "human:owner", 1), chain.owner, "human:owner");
    await admitEnvelope(hostileDoc, boot.envelope, boot.update);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "real work", marks: marks("real work") } }, "human:writer");
    const honest = await commitSigned(writerDoc, tx([{ op: "insert", block, parent: null }], "human:writer", 2), chain.writer, "human:writer");
    // The hostile peer admits the honest block before forging an edit of it
    // (you cannot even commit an edit for a block your doc lacks).
    await admitEnvelope(hostileDoc, honest.envelope, honest.update);
    const evil = await commitSigned(hostileDoc, tx([{ op: "textEdit", block: block.id, changes: [{ insert: "evil" }] }], "human:writer", 2), chain.hostile, "human:writer");

    const peers = [newDocument(DOC), newDocument(DOC)];
    for (const peer of peers) {
      await admitEnvelope(peer, boot.envelope, boot.update);
      expect((await admitEnvelope(peer, honest.envelope, honest.update)).verdict).toBe("allow");
      expect((await admitEnvelope(peer, evil.envelope, evil.update)).verdict).toBe("deny");
    }
    expect(canonicalJson(readState(peers[0]!))).toBe(canonicalJson(readState(peers[1]!)));
    expect(readState(peers[0]!).blocks[block.id]!.text!.s).toBe("real work");
  });
});
