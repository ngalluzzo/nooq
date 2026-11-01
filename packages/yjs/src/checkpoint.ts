/**
 * Checkpoints in the adapter — DM-15, SW-5. The attested state travels as
 * its canonical encoding (Y.encodeStateAsUpdate); a peer rebuilds it and
 * reproduces the digest before trusting anything after it.
 */

import * as Y from "yjs";
import { signCheckpoint, toBase64, updateDigestOf, type ActorKey, type Checkpoint } from "@nooq/core";
import { newDocument } from "./apply.ts";
import { documentHeader } from "./layout.ts";

/** SW-5: the fingerprint of a state's canonical encoding. */
export function stateDigestOf(doc: Y.Doc): Promise<string> {
  return updateDigestOf(Y.encodeStateAsUpdate(doc));
}

/** Attest this document's current state. Returns the checkpoint and the state it attests. */
export async function createCheckpoint(doc: Y.Doc, signer: { actorId: string; key: ActorKey }, previous: string | null): Promise<{ checkpoint: Checkpoint; state: Uint8Array }> {
  const state = Y.encodeStateAsUpdate(doc);
  const checkpoint = await signCheckpoint({
    docId: documentHeader(doc).docId,
    stateVector: toBase64(Y.encodeStateVector(doc)),
    stateDigest: await updateDigestOf(state),
    previous,
    signer: signer.actorId,
  }, signer.key);
  return { checkpoint, state };
}

/** Rebuild an attested state; undefined unless it reproduces the checkpoint's digest and state vector. */
export async function restoreCheckpoint(docId: string, checkpoint: Checkpoint, state: Uint8Array): Promise<Y.Doc | undefined> {
  const doc = newDocument(docId);
  try {
    Y.applyUpdate(doc, state);
  } catch {
    return undefined;
  }
  if ((await stateDigestOf(doc)) !== checkpoint.stateDigest) return undefined;
  if (toBase64(Y.encodeStateVector(doc)) !== checkpoint.stateVector) return undefined;
  return doc;
}
