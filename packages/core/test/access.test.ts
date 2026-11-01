import { describe, expect, test } from "bun:test";
import {
  accessExtends,
  adoptionMatches,
  authorize,
  createActorKey,
  createSecuredDocument,
  isGenesisFor,
  isSecuredDocId,
  keyMismatch,
  newBlockId,
  registrationOf,
  signEnvelope,
  signingInput,
  toBase64,
  updateDigestOf,
  verifyEnvelope,
  wellFormedAccess,
  type Access,
  type Touched,
} from "../src/index.ts";
import { canonicalJson } from "../src/index.ts";
import type { Op, Transaction } from "../src/index.ts";

const DOC = "access-test-doc";

function tx(ops: Op[], actorId: string, kind: "human" | "ai" = "human", lamport = 1): Transaction {
  return { id: newBlockId(), actor: { actorId, kind }, lamport, causality: {}, ops };
}

const noTouch = (): Touched => ({
  inserts: [], structuralOps: false, otherContentOps: false, accessWrites: false,
  deletedBlocks: [], unresolved: false, bookkeepingWrites: false, registration: undefined, accessValues: [],
});
const touchSuggestion = (): Touched => ({ ...noTouch(), inserts: ["nooq.suggestion/v1"] });
const touchAnything = (): Touched => ({ ...noTouch(), inserts: ["nooq.paragraph/v1"], structuralOps: true, otherContentOps: true });

describe("actor keys and signatures (DM-12)", () => {
  test("sign, verify, and detect tampering", async () => {
    const key = await createActorKey();
    const transaction = tx([], "human:alice");
    const input = { docId: DOC, tx: transaction, client: 42, clocks: { from: 0, to: 3 }, updateDigest: "sha256:" + "a".repeat(64) };
    const envelope = await signEnvelope(input, key, "human:alice");

    expect(await verifyEnvelope(envelope, DOC, key.publicBytes)).toBe(true);
    expect(await verifyEnvelope({ ...envelope, tx: tx([], "human:mallory") }, DOC, key.publicBytes)).toBe(false);
    expect(await verifyEnvelope(envelope, "other-doc", key.publicBytes)).toBe(false);
    expect(await verifyEnvelope(envelope, DOC, (await createActorKey()).publicBytes)).toBe(false);
  });

  test("signing input is canonical; update digests fingerprint bytes", async () => {
    const transaction = tx([], "x");
    const a = signingInput({ docId: "d", tx: transaction, client: 1, clocks: { from: 0, to: 0 }, updateDigest: "sha256:x" });
    expect(a).toBe(canonicalJson({ updateDigest: "sha256:x", client: 1, clocks: { to: 0, from: 0 }, tx: transaction, docId: "d" }));
    const digest = await updateDigestOf(new TextEncoder().encode("nooq"));
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await updateDigestOf(new TextEncoder().encode("nooq!"))).not.toBe(digest);
  });
});

describe("secured document identity (DM-13 Draft 1.7)", () => {
  test("the ID commits to owner and nonce", async () => {
    const ownerKey = await createActorKey();
    const owner = { actorId: "human:owner", key: toBase64(ownerKey.publicBytes), kind: "human" as const };
    const { docId, nonce } = await createSecuredDocument(owner);
    expect(isSecuredDocId(docId)).toBe(true);
    expect(isSecuredDocId("access-test-doc")).toBe(false);

    const genesis: Access = { owner, grants: [], nonce };
    expect(await isGenesisFor(docId, genesis)).toBe(true);
    expect(await isGenesisFor(docId, { ...genesis, nonce: "other" })).toBe(false);
    expect(wellFormedAccess(genesis)).toBe(true);
    expect(wellFormedAccess({ owner: { actorId: "x", key: "k" }, grants: [] } as unknown as Access)).toBe(false);
  });

  test("accessExtends: owner and nonce immutable, grants append-only", () => {
    const owner = { actorId: "human:owner", key: "aw==", kind: "human" as const };
    const base: Access = { owner, grants: [], nonce: "n1" };
    expect(accessExtends(base, { owner, grants: [{ actorId: "human:w", key: "k", kind: "human", role: "writer" }], nonce: "n1" })).toBe(true);
    expect(accessExtends(base, { ...base, nonce: "n2" })).toBe(false);
    expect(accessExtends(base, { owner: { ...owner, actorId: "other" }, grants: [], nonce: "n1" })).toBe(false);
    const withGrant: Access = { owner, grants: [{ actorId: "human:w", key: "k", kind: "human", role: "writer" }], nonce: "n1" };
    expect(accessExtends(withGrant, base)).toBe(false);
  });
});

describe("authorize (DM-13 Draft 1.7)", () => {
  const ownerKeyB64 = "b3duZXI=";
  const access: Access = {
    owner: { actorId: "human:owner", key: ownerKeyB64, kind: "human" },
    nonce: "n1",
    grants: [
      { actorId: "human:writer", key: "d3JpdGVy", kind: "human", role: "writer" },
      { actorId: "ai:assistant", key: "YWk", kind: "ai", role: "suggester" },
      { actorId: "human:reader", key: "cmVhZGVy", kind: "human", role: "reader" },
    ],
  };
  /** The envelope's client is registered to this transaction's author (DM-12, DM-14.2). */
  const registered = (transaction: Transaction): Touched => ({ ...noTouch(), registration: registrationOf(transaction) });

  test("open documents: authorize allows all; access denial is the admit layer's", () => {
    // DM-13: an open document never gains access — enforced in admitEnvelope
    // (secured-vs-open is decided by docId before authorize runs).
    expect(authorize(undefined, { tx: tx([], "anyone"), signer: "anyone", signerKey: "any" }, touchAnything())).toBe("allow");
    expect(authorize(undefined, { tx: tx([], "anyone"), signer: "anyone", signerKey: "any" }, { ...touchAnything(), accessWrites: true })).toBe("allow");
  });

  test("signer must be the transaction's author (DM-12)", () => {
    const transaction = tx([], "human:writer");
    expect(authorize(access, { tx: transaction, signer: "human:writer", signerKey: "d3JpdGVy" }, registered(transaction))).toBe("allow");
    expect(authorize(access, { tx: transaction, signer: "human:owner", signerKey: ownerKeyB64 }, registered(transaction))).toBe("deny");
  });

  test("the envelope's client is registered to the transaction's author (DM-12, DM-14.2)", () => {
    const transaction = tx([{ op: "setField", block: "b", key: "k", value: 1 }], "human:writer");
    expect(authorize(access, { tx: transaction, signer: "human:writer", signerKey: "d3JpdGVy" }, registered(transaction))).toBe("allow");
    expect(authorize(access, { tx: transaction, signer: "human:writer", signerKey: "d3JpdGVy" }, noTouch())).toBe("deny"); // unregistered
    expect(authorize(access, { tx: transaction, signer: "human:writer", signerKey: "d3JpdGVy" }, { ...noTouch(), registration: { actorId: "human:owner", kind: "human" } })).toBe("deny");
    expect(authorize(access, { tx: transaction, signer: "human:writer", signerKey: "d3JpdGVy" }, { ...noTouch(), registration: { actorId: "human:writer", kind: "ai" } })).toBe("deny");
  });

  test("unresolved views and bookkeeping writes never authorize", () => {
    expect(authorize(access, { tx: tx([], "human:writer"), signer: "human:writer", signerKey: "d3JpdGVy" }, { ...registered(tx([], "human:writer")), unresolved: true })).toBe("hold");
    expect(authorize(access, { tx: tx([], "human:writer"), signer: "human:writer", signerKey: "d3JpdGVy" }, { ...registered(tx([], "human:writer")), bookkeepingWrites: true })).toBe("deny");
  });

  test("kinds are granted, not claimed (§5)", () => {
    const honestAi = tx([], "ai:assistant", "ai");
    expect(authorize(access, { tx: honestAi, signer: "ai:assistant", signerKey: "YWk" }, registered(honestAi))).toBe("allow");
    const relabeled = tx([], "ai:assistant", "human");
    expect(authorize(access, { tx: relabeled, signer: "ai:assistant", signerKey: "YWk" }, registered(relabeled))).toBe("deny");
  });

  test("suggesters ship suggestion blocks only", () => {
    const suggestionTx = tx([], "ai:assistant", "ai");
    expect(authorize(access, { tx: suggestionTx, signer: "ai:assistant", signerKey: "YWk" }, { ...touchSuggestion(), registration: registrationOf(suggestionTx) })).toBe("allow");
    const overreach = tx([], "ai:assistant", "ai");
    expect(authorize(access, { tx: overreach, signer: "ai:assistant", signerKey: "YWk" }, { ...touchAnything(), registration: registrationOf(overreach) })).toBe("deny");
  });

  test("impersonation denies; strangers hold", () => {
    expect(keyMismatch(access, "human:writer", "bm90LXcyaXRlcg==")).toBe(true);
    const impersonated = tx([], "human:writer");
    expect(authorize(access, { tx: impersonated, signer: "human:writer", signerKey: "bm90LXcyaXRlcg==" }, registered(impersonated))).toBe("deny");
    const stranger = tx([], "human:new");
    expect(authorize(access, { tx: stranger, signer: "human:new", signerKey: "bmV3" }, registered(stranger))).toBe("hold");
  });

  test("access writes are owner-only and append-only", () => {
    const ownerTx = tx([], "human:owner");
    const extended: Access = { ...access, grants: [...access.grants, { actorId: "human:new", key: "bmV3", kind: "human", role: "writer" }] };
    expect(authorize(access, { tx: ownerTx, signer: "human:owner", signerKey: ownerKeyB64 }, { ...registered(ownerTx), accessWrites: true, accessValues: [extended] })).toBe("allow");
    expect(authorize(access, { tx: ownerTx, signer: "human:owner", signerKey: ownerKeyB64 }, { ...registered(ownerTx), accessWrites: true, accessValues: [{ ...extended, nonce: "x" }] })).toBe("deny");
    const writerTx = tx([], "human:writer");
    expect(authorize(access, { tx: writerTx, signer: "human:writer", signerKey: "d3JpdGVy" }, { ...registered(writerTx), accessWrites: true, accessValues: [extended] })).toBe("deny");
  });

  test("adoption ops must canonically equal the proposal's", () => {
    const ops: Op[] = [{ op: "textEdit", block: "b", changes: [{ retain: 1 }, { insert: "x" }] }];
    expect(adoptionMatches(ops, structuredClone(ops))).toBe(true);
    expect(adoptionMatches(ops, [{ op: "textEdit", block: "b", changes: [{ insert: "y" }] }])).toBe(false);
  });
});
