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
import type { Access, ActorId, ActorKind, Grant, Role } from "./model.ts";
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
    const p = item as { actorId?: unknown; key?: unknown; kind?: unknown; name?: unknown } | null;
    return !!p && typeof p.actorId === "string" && p.actorId !== "" && typeof p.key === "string" && p.key !== "" && KINDS.includes(p.kind as ActorKind)
      && (p.name === undefined || (typeof p.name === "string" && p.name.trim() !== "" && p.name.length <= 120));
  };
  const lineage = (value: unknown) => {
    const pin = value as { docId?: unknown; checkpoint?: unknown } | null;
    return value === undefined || (!!pin && typeof pin.docId === "string" && pin.docId !== "" && (pin.checkpoint === null || typeof pin.checkpoint === "string"));
  };
  const epochOf = (value: { epoch?: number }) => value.epoch === undefined || (Number.isInteger(value.epoch) && value.epoch >= 0);
  const revokedOk = (a: Access) => a.revoked === undefined || (Array.isArray(a.revoked) && a.revoked.every((id) => typeof id === "string" && id !== "" && id !== a.owner.actorId) && new Set(a.revoked).size === a.revoked.length);
  return !!access && party(access.owner) && typeof access.nonce === "string" && access.nonce !== "" && Array.isArray(access.grants)
    && epochOf(access) && revokedOk(access) && access.grants.every((grant) => party(grant) && ROLES.includes(grant.role) && epochOf(grant) && (grant.epoch ?? 0) <= (access.epoch ?? 0))
    && lineage(access.rebasedFrom);
}

/** DM-13.6: absent epoch means 0 — pre-epoch documents read identically. */
const epoch = (value: { epoch?: number }): number => value.epoch ?? 0;

/** The owner or grant naming this actor, if any (owner first) — ANY epoch,
 *  for impersonation checks: an actorId listed with a different key is an
 *  impersonation attempt whether or not their grant still authorizes. */
function anyPartyOf(access: Access, actorId: string): (Pick<Grant, "actorId" | "key" | "kind"> & { role: Role; owner: boolean }) | undefined {
  if (access.owner.actorId === actorId) return { ...access.owner, role: "writer", owner: true };
  const grant = access.grants.find((candidate) => candidate.actorId === actorId);
  return grant ? { ...grant, owner: false } : undefined;
}

/** The party that authorizes NOW: the owner, or a grant at the current epoch
 *  (DM-13.6). A grant left behind by rotation no longer admits its actor. */
export function partyOf(access: Access, actorId: string): (Pick<Grant, "actorId" | "key" | "kind"> & { role: Role; epoch?: number; owner: boolean; stale?: boolean }) | undefined {
  if (access.owner.actorId === actorId) return { ...access.owner, role: "writer", owner: true };
  const current = epoch(access);
  const grant = access.grants.find((candidate) => candidate.actorId === actorId);
  if (!grant) return undefined;
  return epoch(grant) === current ? { ...grant, owner: false } : { ...grant, owner: false, stale: true };
}

/** DM-13.6: the revoked roll — for the removed surface ("removed" badge,
 *  history event line) and nothing else. */
export function removedActors(_previous: Access, current: Access): ActorId[] {
  return current.revoked ?? [];
}

export function roleOf(access: Access | undefined, actorId: string, key: string | undefined): Role | "none" {
  if (!access) return "writer"; // open document: no rules but the CRDT's
  const party = partyOf(access, actorId);
  return party && !party.stale && key !== undefined && party.key === key ? party.role : "none";
}

/**
 * An actorId that exists in access with a DIFFERENT key is an
 * impersonation attempt — deny, never hold (DM-13; PHILOSOPHY §5:
 * "a peer can claim another actor's identity" is broken-when).
 */
export function keyMismatch(access: Access | undefined, actorId: string, key: string | undefined): boolean {
  if (!access || key === undefined) return false;
  const party = anyPartyOf(access, actorId);
  return party !== undefined && party.key !== key;
}

/** DM-13: an access write keeps owner, nonce and lineage (DM-16), and extends grants unchanged. */
export function accessExtends(current: Access, next: unknown): boolean {
  if (!wellFormedAccess(next)) return false;
  if (canonicalJson(next.owner) !== canonicalJson(current.owner) || next.nonce !== current.nonce) return false;
  if (canonicalJson(next.rebasedFrom ?? null) !== canonicalJson(current.rebasedFrom ?? null)) return false;
  const currentEpoch = epoch(current), nextEpoch = epoch(next);
  if (nextEpoch === currentEpoch) {
    // Same epoch: grants only grow, prefix-preserved, no duplicates (DM-13).
    if (next.grants.length < current.grants.length) return false;
    if (canonicalJson(next.grants.slice(0, current.grants.length)) !== canonicalJson(current.grants)) return false;
    const ids = new Set([current.owner.actorId]);
    const rollStable = canonicalJson(next.revoked ?? []) === canonicalJson(current.revoked ?? []);
    return next.grants.every((grant) => !ids.has(grant.actorId) && ids.add(grant.actorId)) && rollStable;
  }
  if (nextEpoch === currentEpoch + 1) {
    // DM-13.6 (proposals/0012): ROTATION. Every surviving current-epoch grant
    // is re-stamped at the next epoch — same actor, key, kind, role; omitted
    // actors are revoked. New actors may join at the new epoch. No duplicates.
    // Every kept actor keeps their identity, key, kind and role — re-stamped
    // at the next epoch; omitted actors are revoked (the owner MAY omit any
    // current grant). New actors may join. No silent rewrites, no duplicates,
    // the owner is never a grant.
    const before = new Map(current.grants.filter(g => epoch(g) === currentEpoch).map(g => [g.actorId, g]));
    const nextIds = new Set(next.grants.map(g => g.actorId));
    if (nextIds.has(next.owner.actorId)) return false;
    const keptHonest = next.grants.every(n => {
      if (epoch(n) !== nextEpoch) return false;
      const prior = before.get(n.actorId);
      if (prior === undefined) return true;
      // DM-13.5: a silent rename (a recorded name changed) is a rewrite; an
      // honest ADDITION (absent -> named) is allowed — the spec's promise.
      const sameIdentity = prior.key === n.key && prior.kind === n.kind && prior.role === n.role;
      const nameHonest = (n.name ?? undefined) === (prior.name ?? undefined) || (prior.name === undefined && typeof n.name === "string");
      return sameIdentity && nameHonest;
    });
    const unique = nextIds.size === next.grants.length;
    // The revoked roll is append-only and grows by exactly the omitted
    // current-epoch actors (DM-13.6).
    const omitted = [...before.keys()].filter(id => !nextIds.has(id));
    const priorRoll = current.revoked ?? [];
    const rollExact = (next.revoked ?? []).length === priorRoll.length + omitted.length
      && omitted.every(id => (next.revoked ?? []).includes(id))
      && priorRoll.every(id => (next.revoked ?? []).includes(id));
    return keptHonest && unique && rollExact;
  }
  return false; // epochs advance one at a time; they never go backward
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
  // DM-13.6 (proposals/0012): REVOKED — a grant left behind by rotation, or
  // an actor on the revoked roll — denies, never holds. They were granted,
  // and are no longer. (A peer that has not synced the rotation still sees
  // the old epoch and admits: eventual, per device at sync time.)
  if (party?.stale || (!party && (access.revoked ?? []).includes(signer))) return "deny";
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
