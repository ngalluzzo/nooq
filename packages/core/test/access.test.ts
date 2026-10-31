import { describe, expect, test } from "bun:test";
import {
  adoptionMatches,
  authorize,
  createActorKey,
  signEnvelope,
  signingInput,
  toBase64,
  updateDigestOf,
  verifyEnvelope,
  type Access,
  type Touched,
} from "../src/index.ts";
import { canonicalJson, newBlockId } from "../src/index.ts";
import type { Op, Transaction } from "../src/index.ts";

const DOC = "access-test-doc";

function tx(ops: Op[], actorId: string, lamport = 1): Transaction {
  return { id: newBlockId(), actor: { actorId, kind: actorId.startsWith("ai:") ? "ai" : "human" }, lamport, causality: {}, ops };
}

const touchedSuggestion: Touched = { inserts: ["nooq.suggestion/v1"], structuralOps: false, otherContentOps: false, accessWrites: false, deletedBlocks: [] };
const touchedAnything: Touched = { inserts: ["nooq.paragraph/v1"], structuralOps: true, otherContentOps: true, accessWrites: false, deletedBlocks: [] };
const touchedAccess: Touched = { inserts: [], structuralOps: false, otherContentOps: false, accessWrites: true, deletedBlocks: [] };

describe("actor keys and signatures (DM-12)", () => {
  test("sign, verify, and detect tampering", async () => {
    const key = await createActorKey();
    const transaction = tx([], "human:alice");
    const input = { docId: DOC, tx: transaction, client: 42, clocks: { from: 0, to: 3 }, updateDigest: "sha256:" + "a".repeat(64) };
    const envelope = await signEnvelope(input, key, "human:alice");

    expect(await verifyEnvelope(envelope, DOC, key.publicBytes)).toBe(true);

    // Tampered payload: same sig, different tx
    const tampered = { ...envelope, tx: tx([], "human:mallory") };
    expect(await verifyEnvelope(tampered, DOC, key.publicBytes)).toBe(false);

    // Wrong document
    expect(await verifyEnvelope(envelope, "other-doc", key.publicBytes)).toBe(false);

    // Wrong key
    const other = await createActorKey();
    expect(await verifyEnvelope(envelope, DOC, other.publicBytes)).toBe(false);
  });

  test("signing input is canonical: key order does not matter", () => {
    const transaction = tx([], "x");
    const a = signingInput({ docId: "d", tx: transaction, client: 1, clocks: { from: 0, to: 0 }, updateDigest: "sha256:x" });
    expect(a).toBe(canonicalJson({ updateDigest: "sha256:x", client: 1, clocks: { to: 0, from: 0 }, tx: transaction, docId: "d" }));
  });

  test("update digests fingerprint bytes", async () => {
    const digest = await updateDigestOf(new TextEncoder().encode("nooq"));
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await updateDigestOf(new TextEncoder().encode("nooq!"))).not.toBe(digest);
  });
});

describe("authorize (DM-13)", () => {
  const access: Access = {
    owner: { actorId: "human:owner", key: "b3Nv" },
    grants: [
      { actorId: "human:writer", key: "d3JpdGVy", role: "writer" },
      { actorId: "ai:assistant", key: "YWk=", role: "suggester" },
      { actorId: "human:reader", key: "cmVhZGVy", role: "reader" },
    ],
  };

  test("open documents allow everything (existing behavior)", () => {
    expect(authorize(undefined, { tx: tx([], "anyone"), signer: "anyone" }, touchedAnything)).toBe("allow");
  });

  test("role matrix", () => {
    expect(authorize(access, { tx: tx([], "human:owner"), signer: "human:owner", signerKey: "b3Nv" }, touchedAnything)).toBe("allow");
    expect(authorize(access, { tx: tx([], "human:writer"), signer: "human:writer", signerKey: "d3JpdGVy" }, touchedAnything)).toBe("allow");
    expect(authorize(access, { tx: tx([], "human:reader"), signer: "human:reader", signerKey: "cmVhZGVy" }, touchedSuggestion)).toBe("deny");
  });

  test("suggesters may only create suggestion blocks (PHILOSOPHY §5)", () => {
    expect(authorize(access, { tx: tx([], "ai:assistant"), signer: "ai:assistant", signerKey: "YWk=" }, touchedSuggestion)).toBe("allow");
    expect(authorize(access, { tx: tx([], "ai:assistant"), signer: "ai:assistant", signerKey: "YWk=" }, touchedAnything)).toBe("deny");
  });

  test("ungranted actors hold pending grants; strangers never in", () => {
    expect(authorize(access, { tx: tx([], "human:new"), signer: "human:new", signerKey: "bmV3" }, touchedSuggestion)).toBe("hold");
    // A signer claiming an actorId with the wrong key is a stranger.
    expect(authorize(access, { tx: tx([], "human:writer"), signer: "human:writer", signerKey: "cHJvbWlzZWQ=" }, touchedAnything)).toBe("deny");
  });

  test("access writes are owner-only", () => {
    expect(authorize(access, { tx: tx([], "human:owner"), signer: "human:owner", signerKey: "b3Nv" }, touchedAccess)).toBe("allow");
    expect(authorize(access, { tx: tx([], "human:writer"), signer: "human:writer", signerKey: "d3JpdGVy" }, touchedAccess)).toBe("deny");
  });

  test("adoption ops must canonically equal the proposal's ops", () => {
    const ops: Op[] = [{ op: "textEdit", block: "b", changes: [{ retain: 1 }, { insert: "x" }] }];
    expect(adoptionMatches(ops, structuredClone(ops))).toBe(true);
    expect(adoptionMatches(ops, [{ op: "textEdit", block: "b", changes: [{ insert: "y" }] }])).toBe(false);
  });
});
