/**
 * Peer inks are derived, not assigned: a pure function of the actor ID, so
 * every peer computes the same color for a collaborator with no coordination
 * (the same discipline as DM-6.2's derived suggestion state).
 */

import { sha256, toHex } from "@nooq/core";

export const PEER_INKS = ["teal", "violet", "green", "sepia", "magenta", "slate"] as const;
export type PeerInk = (typeof PEER_INKS)[number];

/** First 8 hex digits of sha256(actorId), as an integer, mod 6. */
export async function peerInk(actorId: string): Promise<PeerInk> {
  const hex = toHex(await sha256(new TextEncoder().encode(actorId)));
  return PEER_INKS[parseInt(hex.slice(0, 8), 16) % PEER_INKS.length]!;
}
