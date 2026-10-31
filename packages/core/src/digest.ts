/**
 * Fingerprints — DM-2. `sha256:` + 64 lowercase hex digits over the UTF-8
 * canonical bytes of a digest input. Adapted from gooi identity rules.
 */

import { canonicalJson } from "./canonical.ts";

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return new Uint8Array(buffer);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function fingerprint(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  return "sha256:" + toHex(await sha256(encoded));
}
