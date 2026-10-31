/**
 * Access rules — DM-13.
 *
 * authorize() is PURE: every peer — relays included — applies it
 * identically before applying an update (SW-1.2). No peer applies any
 * other content policy. A document without `access` is open mode and
 * everything is allowed (existing behavior).
 */

import type { Envelope } from "./actor.ts";
import { canonicalJson } from "./canonical.ts";
import type { Access, Role } from "./model.ts";

export const SUGGESTION_TYPE = "nooq.suggestion/v1";

/** What an update touches, resolved from its structs (DM-13's `touched`). */
export interface Touched {
  /** Block types inserted (suggestion-only check for suggesters). */
  inserts: string[];
  /** Structural ops: move/delete/restore of non-suggestion blocks. */
  structuralOps: boolean;
  /** Any op other than suggestion-block creation/attachment. */
  otherContentOps: boolean;
  /** Writes to the access header itself. */
  accessWrites: boolean;
  /** Blocks whose placement is deleted (tombstones). */
  deletedBlocks: string[];
}

export type Verdict = "allow" | "hold" | "deny";

export function roleOf(access: Access | undefined, actorId: string, key: string): Role | "none" {
  if (!access) return "writer"; // open document: everything is allowed
  if (access.owner.actorId === actorId && keysEqual(access.owner.key, key)) return "writer";
  for (const grant of access.grants) {
    if (grant.actorId === actorId && keysEqual(grant.key, key)) return grant.role;
  }
  return "none";
}

function keysEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * Pure authorization. Signature verification happens before this
 * (verifyEnvelope with the key bound to the signer's grant); authorize
 * decides what a verified actor may do, and whether a not-yet-granted
 * actor pends.
 */
export function authorize(
  access: Access | undefined,
  envelope: Pick<Envelope, "tx" | "signer"> & { signerKey?: string },
  touched: Touched,
): Verdict {
  if (!access) return "allow"; // open mode (DM-13)

  // Access writes are owner-only, regardless of other grants.
  if (touched.accessWrites) {
    if (access.owner.actorId === envelope.signer && (!envelope.signerKey || keysEqual(access.owner.key, envelope.signerKey))) {
      return "allow";
    }
    return "deny";
  }

  const role = roleOf(access, envelope.signer, envelope.signerKey ?? access.owner.key);
  if (role === "none") {
    // Validly signed but not granted: hold pending grants (DM-13).
    return "hold";
  }
  if (role === "writer") return "allow";
  if (role === "reader") return "deny";
  if (role === "suggester") {
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
  return canonicalJsonSafe(adoptionOps) === canonicalJsonSafe(proposalOps);
}

function canonicalJsonSafe(value: unknown): string {
  return canonicalJson(value);
}
