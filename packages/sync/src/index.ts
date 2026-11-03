/**
 * @nooq/sync — wire sessions and the reference loopback hosted peer
 * implementing SYNC.md over the Yjs adapter.
 */

export { fromBase64, toBase64 } from "./base64.ts";
export {
  BACKEND,
  WIRE_VERSION,
  decodeMessage,
  encodeMessage,
  errorFor,
  type Cursor,
  type CursorAnchor,
  type WireCheckpoint,
  type WireMessage,
} from "./messages.ts";
export { NooqRelay, type NooqRelayOptions } from "./relay.ts";
export { REMOTE_ORIGIN, SyncSession, type AwarenessEntry, type OutboxEntry, type SyncSessionOptions } from "./session.ts";
export type { SyncTransport } from "./transport.ts";
export { settled } from "./transport.ts";
export { createBlobStore, blobSrc, digestOfBlobSrc, type BlobStore } from "./blob-store.ts";
