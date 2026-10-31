/**
 * Actors and signatures — DM-12.
 *
 * Ed25519 via WebCrypto (raw 32-byte public keys; verified on Bun 1.4.4
 * and browsers). An envelope's signature covers the canonical JSON of
 * {docId, tx, client, clocks, updateDigest} — the transaction, its
 * author, and the exact bytes of its effects.
 */

import { canonicalJson } from "./canonical.ts";
import { sha256, toHex } from "./digest.ts";
import type { Transaction } from "./model.ts";

export interface ActorKey {
  /** Ed25519 private key, extractable for storage. */
  private: CryptoKey;
  /** Raw 32-byte public key. */
  publicBytes: Uint8Array;
}

export interface Clocks {
  from: number;
  to: number; // inclusive
}

export interface Envelope {
  tx: Transaction;
  client: number;
  clocks: Clocks;
  /** sha256 fingerprint of the update bytes. */
  updateDigest: string;
  /** base64 Ed25519 signature over the canonical signing input. */
  sig: string;
  /** asserted by the sender; verified against access.grants (DM-13). */
  signer: string;
}

export async function createActorKey(): Promise<ActorKey> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { private: pair.privateKey, publicBytes };
}

/** The canonical bytes an envelope signature covers (DM-12). */
export function signingInput(input: {
  docId: string;
  tx: Transaction;
  client: number;
  clocks: Clocks;
  updateDigest: string;
}): string {
  return canonicalJson({
    docId: input.docId,
    tx: input.tx,
    client: input.client,
    clocks: input.clocks,
    updateDigest: input.updateDigest,
  });
}

export async function signEnvelope(
  input: { docId: string; tx: Transaction; client: number; clocks: Clocks; updateDigest: string },
  key: ActorKey,
  signer: string,
): Promise<Envelope> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.private,
    new TextEncoder().encode(signingInput(input)),
  );
  return {
    tx: structuredClone(input.tx),
    client: input.client,
    clocks: input.clocks,
    updateDigest: input.updateDigest,
    sig: toBase64(new Uint8Array(signature)),
    signer,
  };
}

/** Verify an envelope's signature against a raw 32-byte Ed25519 public key. */
export async function verifyEnvelope(
  envelope: Envelope,
  docId: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", publicKey as unknown as BufferSource, "Ed25519", true, ["verify"]);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64(envelope.sig) as unknown as BufferSource,
    new TextEncoder().encode(
      signingInput({
        docId,
        tx: envelope.tx,
        client: envelope.client,
        clocks: envelope.clocks,
        updateDigest: envelope.updateDigest,
      }),
    ),
  );
}

/** Fingerprint of an update's bytes — the envelope's updateDigest. */
export async function updateDigestOf(update: Uint8Array): Promise<string> {
  return "sha256:" + toHex(await sha256(update));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
