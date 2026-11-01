/**
 * Versions and rebase — DM-14.5, DM-16.
 *
 * A version is a Yjs snapshot (state vector + delete set). GC is off, so
 * live state plus a snapshot rebuilds that past state exactly. Rebase is
 * the explicit compaction: a new lineage whose first transaction carries the
 * visible state with fresh CRDT identities and no tombstones.
 */

import * as Y from "yjs";
import {
  isSecuredDocId,
  newBlockId,
  rebaseOps,
  securedDocId,
  type Access,
  type ActorDescriptor,
  type ActorKey,
  type Transaction,
} from "@nooq/core";
import { applyTransaction, newDocument } from "./apply.ts";
import { commitSigned, type Committed } from "./enforcement.ts";
import { documentHeader } from "./layout.ts";
import { readState } from "./read.ts";

/** DM-14.5: pin this document's current state as a version (an encoded snapshot). */
export function versionOf(doc: Y.Doc): Uint8Array {
  return Y.encodeSnapshot(Y.snapshot(doc));
}

/** DM-14.5: the document as it was at a version, as a new read-only document. */
export function stateAt(doc: Y.Doc, version: Uint8Array): Y.Doc {
  return Y.createDocFromSnapshot(doc, Y.decodeSnapshot(version), newDocument(documentHeader(doc).docId, documentHeader(doc).schemaVersion));
}

export interface RebaseOptions {
  /** The new lineage's ID. A secured document's is derived from its new access (same owner and grants, new nonce). */
  docId: string;
  actor: ActorDescriptor;
  lamport: number;
  /** Secured documents: the new genesis access, pinning `rebasedFrom`. */
  access?: Access;
  /** Secured documents: the owner's key; only the owner signs a genesis (DM-13). */
  key?: ActorKey;
}

/**
 * DM-16: a new lineage carrying this document's visible state. In secured
 * documents the owner signs one genesis envelope: the new access, pinned to
 * the old lineage, and every live block. The old document is untouched: it
 * becomes the archive that answers history, attribution and versions.
 */
export async function rebase(doc: Y.Doc, options: RebaseOptions): Promise<{ doc: Y.Doc; genesis?: Committed }> {
  const state = readState(doc);
  const lineage = newDocument(options.docId, state.schemaVersion);
  const tx = (ops: Transaction["ops"]): Transaction => ({ id: newBlockId(), actor: options.actor, lamport: options.lamport, causality: {}, intent: "rebase", ops });
  if (isSecuredDocId(state.docId) && !state.access) throw new Error("a secured document awaiting genesis has nothing to rebase");
  if (!state.access) {
    const ops = rebaseOps(state);
    if (ops.length > 0) applyTransaction(lineage, tx(ops));
    return { doc: lineage };
  }
  const { access, key } = options;
  if (!access || !key) throw new Error("rebasing a secured document needs the new access and the owner's key");
  if (options.actor.actorId !== state.access.owner.actorId || access.owner.actorId !== state.access.owner.actorId || access.owner.key !== state.access.owner.key) {
    throw new Error("only the owner rebases a secured document: only the owner signs a genesis (DM-16)");
  }
  if ((await securedDocId(access.owner, access.nonce)) !== options.docId) throw new Error("the new docId must derive from the new access");
  if (access.rebasedFrom?.docId !== state.docId) throw new Error("the new genesis must pin the lineage it was rebased from");
  const genesis = await commitSigned(lineage, tx([{ op: "setAccess", access }, ...rebaseOps(state)]), key, options.actor.actorId);
  return { doc: lineage, genesis };
}
