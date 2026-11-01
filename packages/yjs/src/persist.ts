/**
 * Persistence — DM-14.6. A document at rest is its header beside its
 * canonical state encoding (SW-5); a secured document loaded from a store
 * the host does not trust is verified against its checkpoint and envelopes.
 * An envelope log is a set: replay admits in any order (SW-6).
 */

import * as Y from "yjs";
import { verifyCheckpoint, type Checkpoint, type Envelope } from "@nooq/core";
import { newDocument } from "./apply.ts";
import { restoreCheckpoint } from "./checkpoint.ts";
import { admitEnvelope } from "./enforcement.ts";
import { documentHeader } from "./layout.ts";
import { readState } from "./read.ts";

/** DM-14.6: a document at rest. The header travels beside the state, never inside it. */
export interface StoredDocument {
  docId: string;
  schemaVersion: number;
  /** Canonical encoding (SW-5): identical states store identical bytes. */
  state: Uint8Array;
}

export interface LogEntry {
  envelope: Envelope;
  update: Uint8Array;
}

/** A checkpoint at rest or on the wire: the checkpoint, the state it attests, and its owner-signed access proof (DM-15). */
export interface AttestedState {
  checkpoint: Checkpoint;
  state: Uint8Array;
  accessProof: Envelope;
}

export type Verified =
  | { ok: true; doc: Y.Doc }
  | { ok: false; code: "checkpoint-invalid" | "envelope-log-invalid" | "stored-state-mismatch"; reason: string; envelope?: Envelope };

export function storeDocument(doc: Y.Doc): StoredDocument {
  const { docId, schemaVersion } = documentHeader(doc);
  return { docId, schemaVersion, state: Y.encodeStateAsUpdate(doc) };
}

/** Load a stored document as is. Verification is verifyStoredDocument's. */
export function loadDocument(stored: StoredDocument): Y.Doc {
  const doc = newDocument(stored.docId, stored.schemaVersion);
  Y.applyUpdate(doc, stored.state);
  return doc;
}

/**
 * DM-14.6: rebuild a document from its checkpoint (or genesis) and its
 * envelopes, in any order. Held envelopes are retried until none admits; a
 * denied one, or one still held at the end, fails verification.
 */
export async function verifyLog(docId: string, log: { checkpoint?: AttestedState; envelopes: Iterable<LogEntry> }): Promise<Verified> {
  let doc = newDocument(docId);
  if (log.checkpoint) {
    const { checkpoint, state, accessProof } = log.checkpoint;
    const restored = await restoreCheckpoint(docId, checkpoint, state);
    if (!restored) return { ok: false, code: "checkpoint-invalid", reason: "checkpoint state does not reproduce its digest" };
    const verdict = await verifyCheckpoint(checkpoint, { docId, access: readState(restored).access, accessProof });
    if (!verdict.ok) return { ok: false, code: "checkpoint-invalid", reason: verdict.reason };
    doc = restored;
  }
  let pending = [...log.envelopes];
  for (let progress = true; progress && pending.length > 0;) {
    progress = false;
    const held: LogEntry[] = [];
    for (const entry of pending) {
      const admission = await admitEnvelope(doc, entry.envelope, entry.update);
      if (admission.verdict === "deny") return { ok: false, code: "envelope-log-invalid", reason: `envelope denied: ${admission.reason}`, envelope: entry.envelope };
      if (admission.verdict === "hold") held.push(entry);
      else progress = true;
    }
    pending = held;
  }
  if (pending.length > 0) {
    return { ok: false, code: "envelope-log-invalid", reason: `${pending.length} envelope(s) never became admissible`, envelope: pending[0]!.envelope };
  }
  return { ok: true, doc };
}

/** DM-14.6: a stored document must equal the replay of its log, in the canonical encoding. */
export async function verifyStoredDocument(stored: StoredDocument, log: { checkpoint?: AttestedState; envelopes: Iterable<LogEntry> }): Promise<Verified> {
  const replayed = await verifyLog(stored.docId, log);
  if (!replayed.ok) return replayed;
  const loaded = loadDocument(stored);
  if (!sameBytes(Y.encodeStateAsUpdate(loaded), Y.encodeStateAsUpdate(replayed.doc))) {
    return { ok: false, code: "stored-state-mismatch", reason: "the stored state holds what its log does not attest, or lacks what it does" };
  }
  return { ok: true, doc: loaded };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
