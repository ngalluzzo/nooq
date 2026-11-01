/**
 * Client registry — DM-14.2. Each Yjs client ID is registered, once, to the
 * actor whose items it writes, so a character's author is its item's client:
 * attribution without per-edit rewrites or a replicated log.
 */

import { canonicalJson } from "./canonical.ts";
import type { ActorId, ActorKind, Transaction } from "./model.ts";

export interface ClientRegistration {
  actorId: ActorId;
  kind: ActorKind;
  model?: string;
  /** Adoption clients (DM-6.3): the proposer authors, this writer accepted. */
  adoptedBy?: ActorId;
}

/** Who a transaction's writes are attributed to. `plugin` is per-command metadata, kept in history, not authorship. */
export function registrationOf(tx: Transaction): ClientRegistration {
  return {
    actorId: tx.actor.actorId,
    kind: tx.actor.kind,
    ...(tx.actor.model !== undefined ? { model: tx.actor.model } : {}),
    ...(tx.adoptedBy !== undefined ? { adoptedBy: tx.adoptedBy } : {}),
  };
}

/** DM-12: an envelope's client is registered to exactly its transaction's attribution. */
export function registrationMatches(value: unknown, tx: Transaction): boolean {
  if (value === undefined) return false;
  try {
    return canonicalJson(value) === canonicalJson(registrationOf(tx));
  } catch {
    return false;
  }
}
