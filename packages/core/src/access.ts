/**
 * Access rules — DM-13.
 *
 * authorize() is PURE: every peer — relays included — applies it
 * identically before applying an update (SW-1.2). No peer applies any
 * other content policy. Open documents have no rules but the CRDT's;
 * secured documents are decided by their ID (securedDocId), never by
 * whether an `access` header happens to be present.
 */

import type { Envelope } from "./actor.ts";
import { canonicalJson } from "./canonical.ts";
import { fingerprint } from "./digest.ts";
import type { Access, ActorKind, Grant, Role } from "./model.ts";
import { registrationMatches } from "./registry.ts";

export const SUGGESTION_TYPE = "nooq.suggestion/v1";

/** What an update touches, resolved from its structs (DM-13's `touched`). */
export interface Touched {
  /** Block types inserted (suggestion-only check for suggesters). */
  inserts: string[];
  /** Structural ops: move/delete/restore of non-suggestion blocks. */
  structuralOps: boolean;
  /** Any op other than suggestion-block creation/attachment. */
  otherContentOps: boolean;
  /** Writes or deletes in the access header itself. */
  accessWrites: boolean;
  /** Blocks whose placement is deleted (tombstones). */
  deletedBlocks: string[];
  /** A struct or delete whose target the receiver cannot resolve yet (DM-12). */
  unresolved: boolean;
  /** Writes outside the document's own roots, or registry writes other than the envelope client's own first one (DM-12). */
  bookkeepingWrites: boolean;
  /** The envelope client's registration, from the store or written by this update; undefined when unregistered (DM-12, DM-14.2). */
  registration: unknown;
  /** New `access` values the update writes (DM-13 append-only check). */
  accessValues: unknown[];
}

export type Verdict = "allow" | "hold" | "deny";

const KINDS: readonly ActorKind[] = ["human", "ai", "importer", "migration", "system"];
const ROLES: readonly Role[] = ["writer", "suggester", "reader", "checkpointer"];

/** Shape check shared by the engine and the append-only rule. */
export function wellFormedAccess(value: unknown): value is Access {
  const access = value as Access | null;
  const party = (item: unknown) => {
    const p = item as { actorId?: unknown; key?: unknown; kind?: unknown } | null;
    return !!p && typeof p.actorId === "string" && p.actorId !== "" && typeof p.key === "string" && p.key !== "" && KINDS.includes(p.kind as ActorKind);
  };
  return !!access && party(access.owner) && typeof access.nonce === "string" && access.nonce !== "" && Array.isArray(access.grants)
    && access.grants.every((grant) => party(grant) && ROLES.includes(grant.role));
}

/** The owner or grant naming this actor, if any (owner first). */
function partyOf(access: Access, actorId: string): (Pick<Grant, "actorId" | "key" | "kind"> & { role: Role; owner: boolean }) | undefined {
  if (access.owner.actorId === actorId) return { ...access.owner, role: "writer", owner: true };
  const grant = access.grants.find((candidate) => candidate.actorId === actorId);
  return grant ? { ...grant, owner: false } : undefined;
}

export function roleOf(access: Access | undefined, actorId: string, key: string | undefined): Role | "none" {
  if (!access) return "writer"; // open document: no rules but the CRDT's
  const party = partyOf(access, actorId);
  return party && key !== undefined && party.key === key ? party.role : "none";
}

/**
 * An actorId that exists in access with a DIFFERENT key is an
 * impersonation attempt — deny, never hold (DM-13; PHILOSOPHY §5:
 * "a peer can claim another actor's identity" is broken-when).
 */
export function keyMismatch(access: Access | undefined, actorId: string, key: string | undefined): boolean {
  if (!access || key === undefined) return false;
  const party = partyOf(access, actorId);
  return party !== undefined && party.key !== key;
}

/** DM-13: an access write keeps owner and nonce and extends grants unchanged. */
export function accessExtends(current: Access, next: unknown): boolean {
  if (!wellFormedAccess(next)) return false;
  if (canonicalJson(next.owner) !== canonicalJson(current.owner) || next.nonce !== current.nonce) return false;
  if (next.grants.length < current.grants.length) return false;
  if (canonicalJson(next.grants.slice(0, current.grants.length)) !== canonicalJson(current.grants)) return false;
  const ids = new Set([current.owner.actorId]);
  return next.grants.every((grant) => !ids.has(grant.actorId) && ids.add(grant.actorId));
}

/**
 * Pure authorization of a secured document's envelope. Signature
 * verification happens before this, with the key bound to the signer;
 * `signerKey` is that key, or undefined when the signer is not granted.
 */
export function authorize(
  access: Access | undefined,
  envelope: Pick<Envelope, "tx" | "signer"> & { signerKey: string | undefined },
  touched: Touched,
): Verdict {
  if (!access) return "allow"; // open document (DM-13)
  // Never decide on a partial view: every peer must reach the same verdict.
  if (touched.unresolved) return "hold";
  if (touched.bookkeepingWrites) return "deny";

  const { tx, signer, signerKey } = envelope;
  // DM-12: the signer is the transaction's author.
  if (signer !== (tx.adoptedBy ?? tx.actor.actorId)) return "deny";
  // DM-12: the envelope's client is registered to this transaction's author.
  if (!registrationMatches(touched.registration, tx)) return "deny";

  if (keyMismatch(access, signer, signerKey)) return "deny";
  const party = partyOf(access, signer);
  if (!party || signerKey === undefined) return "hold"; // validly signed, not granted yet

  // DM-13: kinds are granted, not claimed.
  if (!tx.adoptedBy && tx.actor.kind !== party.kind) return "deny";
  if (tx.adoptedBy) {
    const proposer = partyOf(access, tx.actor.actorId);
    if (proposer && proposer.kind !== tx.actor.kind) return "deny";
  }

  if (touched.accessWrites) {
    if (!party.owner || touched.accessValues.length !== 1) return "deny";
    return accessExtends(access, touched.accessValues[0]) ? "allow" : "deny";
  }

  if (party.role === "writer") return "allow";
  if (party.role === "suggester" && !tx.adoptedBy) {
    const onlySuggestions =
      touched.inserts.every((type) => type === SUGGESTION_TYPE) &&
      !touched.structuralOps &&
      !touched.otherContentOps &&
      touched.deletedBlocks.length === 0;
    return onlySuggestions ? "allow" : "deny";
  }
  return "deny";
}

/** DM-13: an adoption's ops must canonically equal the proposal's ops. */
export function adoptionMatches(
  adoptionOps: ReadonlyArray<unknown>,
  proposalOps: ReadonlyArray<unknown>,
): boolean {
  return sameJson(adoptionOps, proposalOps);
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

const SECURED = /^nooq:sha256:[0-9a-f]{64}$/;

/** DM-13: a secured document's ID commits to its owner and nonce. */
export async function securedDocId(owner: Access["owner"], nonce: string): Promise<string> {
  return "nooq:" + (await fingerprint({ owner: { actorId: owner.actorId, key: owner.key, kind: owner.kind }, nonce }));
}

/** Secured or open is decided by the ID alone, before any byte arrives. */
export function isSecuredDocId(docId: string): boolean {
  return SECURED.test(docId);
}

/** A fresh secured document identity for an owner. */
export async function createSecuredDocument(owner: Access["owner"]): Promise<{ docId: string; nonce: string }> {
  const nonce = crypto.randomUUID();
  return { docId: await securedDocId(owner, nonce), nonce };
}

/** DM-13 genesis: an access value whose owner and nonce derive this ID. */
export async function isGenesisFor(docId: string, value: unknown): Promise<boolean> {
  return isSecuredDocId(docId) && wellFormedAccess(value) && (await securedDocId(value.owner, value.nonce)) === docId;
}
