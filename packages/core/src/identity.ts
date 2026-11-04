/**
 * Fingerprint identity (DM-12.4, user-model stage 2): an actorId DERIVES
 * from its Ed25519 public key — did:key's lesson, applied to actor ids.
 * The encoding is multibase base58btc ("z") over the multicodec-prefixed
 * raw key ([0xed, 0x01] = ed25519-pub), so every derived id begins "z6Mk"
 * and carries its own decoding instructions. A handle cannot be claimed,
 * only proven: claiming `human:z6Mk…` without the matching key is a
 * validation failure, not a social problem.
 *
 * Base58btc (Bitcoin alphabet) encode only — verification never decodes:
 * peers re-derive from the presented key and compare.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btc(bytes: Uint8Array): string {
  let magnitude = BigInt(0);
  for (const byte of bytes) magnitude = magnitude * 256n + BigInt(byte);
  let encoded = "";
  while (magnitude > 0n) {
    encoded = BASE58_ALPHABET[Number(magnitude % 58n)]! + encoded;
    magnitude /= 58n;
  }
  // Leading zero bytes encode as leading '1's.
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

/** The multicodec prefix for Ed25519 public keys (ed25519-pub, 0xed 0x01). */
const ED25519_PUB = new Uint8Array([0xed, 0x01]);

/**
 * Derive the canonical actorId for a key and kind: `kind:z<multibase>`.
 * Pure, deterministic, dependency-free. The base64 form (grants) or raw
 * bytes both accepted — one truth, two spellings.
 */
export function actorIdOf(kind: "human" | "ai" | "importer" | "migration" | "system", key: Uint8Array | string): string {
  const raw = typeof key === "string" ? Uint8Array.from(atob(key), ch => ch.charCodeAt(0)) : key;
  const prefixed = new Uint8Array(ED25519_PUB.length + raw.length);
  prefixed.set(ED25519_PUB, 0);
  prefixed.set(raw, ED25519_PUB.length);
  return `${kind}:z${base58btc(prefixed)}`;
}

/** Whether an actorId is in derived form (a kind prefix and the z-multibase). */
export function isDerivedActorId(actorId: string): boolean {
  const at = actorId.indexOf(":z");
  return at > 0 && actorId.length > at + 8;
}

/** Re-derive and compare: does this actorId prove this key? */
export function actorIdMatches(actorId: string, kind: string, key: Uint8Array | string): boolean {
  return actorId === actorIdOf(kind as "human", key);
}
