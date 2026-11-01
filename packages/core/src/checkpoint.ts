/**
 * Checkpoints — DM-15. A signed attestation of a state, so a joiner verifies
 * from it instead of replaying every envelope since genesis.
 *
 * In a secured document the signer's authority comes from the access header
 * inside the attested state, which a forger could write. So that access is
 * proven by the owner: its owner and nonce derive the document ID, and the
 * latest owner-signed access write (the access proof) carries exactly it.
 */

import { securedDocId, wellFormedAccess } from "./access.ts";
import { fromBase64, toBase64, verifyEnvelope, type ActorKey, type Envelope } from "./actor.ts";
import { canonicalJson } from "./canonical.ts";
import { fingerprint } from "./digest.ts";
import type { Access, ActorId } from "./model.ts";

export interface Checkpoint {
  docId: string;
  /** base64 Yjs state vector of the attested state. */
  stateVector: string;
  /** Fingerprint of the state's canonical encoding (SW-5). */
  stateDigest: string;
  /** checkpointId of the previous checkpoint, or null for the first. */
  previous: string | null;
  signer: ActorId;
  /** base64 Ed25519 signature over the canonical JSON of every other field. */
  sig: string;
}

const body = (checkpoint: Omit<Checkpoint, "sig">) => canonicalJson({
  docId: checkpoint.docId,
  stateVector: checkpoint.stateVector,
  stateDigest: checkpoint.stateDigest,
  previous: checkpoint.previous,
  signer: checkpoint.signer,
});

export async function signCheckpoint(checkpoint: Omit<Checkpoint, "sig">, key: ActorKey): Promise<Checkpoint> {
  const signature = await crypto.subtle.sign("Ed25519", key.private, new TextEncoder().encode(body(checkpoint)));
  return { ...checkpoint, sig: toBase64(new Uint8Array(signature)) };
}

export async function verifyCheckpointSignature(checkpoint: Checkpoint, publicKey: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey as unknown as BufferSource, "Ed25519", true, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromBase64(checkpoint.sig) as unknown as BufferSource, new TextEncoder().encode(body(checkpoint)));
  } catch {
    return false;
  }
}

/** A checkpoint's identity, for the next one's `previous`. */
export function checkpointId(checkpoint: Checkpoint): Promise<string> {
  return fingerprint(checkpoint);
}

/** DM-15: the owner, a writer, or a checkpointer may attest; the key it signs with. */
export function checkpointSignerKey(access: Access, signer: ActorId): string | undefined {
  if (access.owner.actorId === signer) return access.owner.key;
  const grant = access.grants.find((candidate) => candidate.actorId === signer);
  return grant && (grant.role === "writer" || grant.role === "checkpointer") ? grant.key : undefined;
}

/**
 * Verify a secured checkpoint against the access its state holds. The
 * state's digest is the adapter's to check (it needs the CRDT encoding).
 */
export async function verifyCheckpoint(
  checkpoint: Checkpoint,
  context: { docId: string; access: unknown; accessProof: Envelope | undefined },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { docId, access, accessProof } = context;
  if (checkpoint.docId !== docId) return { ok: false, reason: "checkpoint for another document" };
  if (!wellFormedAccess(access) || (await securedDocId(access.owner, access.nonce)) !== docId) {
    return { ok: false, reason: "attested access does not derive this document" };
  }
  if (!accessProof || accessProof.signer !== access.owner.actorId || !(await verifyEnvelope(accessProof, docId, fromBase64(access.owner.key)))) {
    return { ok: false, reason: "no owner-signed access proof" };
  }
  const written = [...accessProof.tx.ops].reverse().find((op) => op.op === "setAccess");
  if (!written || written.op !== "setAccess" || canonicalJson(written.access) !== canonicalJson(access)) {
    return { ok: false, reason: "attested access is not the owner's latest" };
  }
  const key = checkpointSignerKey(access, checkpoint.signer);
  if (!key) return { ok: false, reason: "signer may not attest checkpoints" };
  if (!(await verifyCheckpointSignature(checkpoint, fromBase64(key)))) return { ok: false, reason: "checkpoint signature" };
  return { ok: true };
}
