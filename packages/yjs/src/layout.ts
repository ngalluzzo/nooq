/**
 * Yjs layout — DM-9 reference mapping.
 *
 * Y.Doc structure:
 * - header:  Y.Map { docId, schemaVersion }
 * - blocks:  Y.Map<BlockId, Y.Map> — each block:
 *     type: string
 *     fields: Y.Map<key, {value, actor, lamport} | raw initial JsonValue>
 *     children: Y.Array<BlockId>       (physical sibling order)
 *     text?: Y.Text                    (per-character marks as attributes)
 *     createdBy: ActorId
 *     textBy?: {actor, lamport}
 * - roots: Y.Array<BlockId>
 * - placement: Y.Map<BlockId, Placement> — the AUTHORITY for where a block
 *   lives or whether it is tombstoned. LWW by Yjs (deterministic across
 *   peers). The spec's DM-4.7 "(lamport, actorId) max" is realized as
 *   Yjs's deterministic (clock, clientID) resolution; the invariant that
 *   matters — a pure function of the merged op set, identical on every
 *   peer — holds.
 * - log: Y.Array<Transaction JSON> — durable intent (DM-4).
 *
 * Concurrency strategy: children/roots arrays may transiently contain
 * strays after merges; projection (read.ts) trusts only the placement
 * register, so strays never surface. normalize() physically reconciles
 * arrays to the register, idempotently.
 */

import type * as Y from "yjs";
import type { ActorId, BlockId, JsonValue } from "@nooq/core";

/** Discriminator for field register wrappers; the key `nooq` with this value is reserved (apply.ts). */
export const REGISTER = "register/1";

export interface Register {
  nooq: typeof REGISTER;
  value: JsonValue;
  actor: ActorId;
  lamport: number;
}

export interface Placement {
  parent: BlockId | null;
  lamport: number;
  actor: ActorId;
  tombstoned?: true;
}

export interface YjsLayout {
  blocks: Y.Map<Y.Map<unknown>>;
  roots: Y.Array<BlockId>;
  placement: Y.Map<Placement>;
  /** DM-13: replicated access header (owner + append-only grants). */
  access: Y.Map<unknown>;
  log: Y.Array<unknown>;
}

/**
 * Document header (docId, schemaVersion) is SIDE-CHANNEL metadata, never
 * CRDT content (SYNC.md Draft 1.2): writing it into the document consumed
 * clock numbers 0–1, so every real item started at clock 2 and Yjs
 * correctly pended increments on peers that had not seen the base.
 * Registered by newDocument; peers that only receive updates project a
 * docId of "" (digests never cover it — DM-6.1 digests roots and blocks).
 */
export interface DocumentHeader {
  docId: string;
  schemaVersion: number;
}

const headers = new WeakMap<Y.Doc, DocumentHeader>();

export function registerHeader(doc: Y.Doc, header: DocumentHeader): void {
  headers.set(doc, header);
}

export function documentHeader(doc: Y.Doc): DocumentHeader {
  return headers.get(doc) ?? { docId: "", schemaVersion: 1 };
}

export function layout(doc: Y.Doc): YjsLayout {
  return {
    blocks: doc.getMap<Y.Map<unknown>>("blocks"),
    roots: doc.getArray<BlockId>("roots"),
    placement: doc.getMap<Placement>("placement"),
    access: doc.getMap("access"),
    log: doc.getArray("log"),
  };
}
