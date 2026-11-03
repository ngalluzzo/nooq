/**
 * The blob client (0014): content-addressed bytes over the ordinary
 * transport. The store WRAPS a transport — blob replies are tapped before
 * the session ever sees them, everything else passes through untouched —
 * and verifies on arrival: a fetched blob is re-hashed, and only a digest
 * match is accepted. Content-addressed means immutable: the cache is
 * forever, by construction.
 */
import { sha256, toHex } from "@nooq/core";
import { fromBase64, toBase64 } from "./base64.ts";
import { decodeMessage, encodeMessage, WIRE_VERSION } from "./messages.ts";
import type { SyncTransport } from "./transport.ts";

/** The src scheme 0014 names: `nooq-blob:<digest>`. */
export function blobSrc(digest: string): string { return `nooq-blob:${digest}`; }
export function digestOfBlobSrc(src: string): string | null {
  if (!src.startsWith("nooq-blob:")) return null;
  return src.slice("nooq-blob:".length) || null;
}

export interface BlobStore {
  /** Store bytes; the digest names them. */
  put(bytes: Uint8Array): Promise<string>;
  /** Fetch by digest, verify by re-hash (a mismatch rejects — 0014's proof), cache forever. */
  get(digest: string): Promise<Uint8Array>;
  /** The wrapped transport — hand THIS to the session; blob replies never reach it. */
  transport: SyncTransport;
}

/**
 * Wrap a transport with the blob channel. Replies are routed by shape:
 * blob-ok WITHOUT bytes is a put's ack; blob-ok WITH bytes is a get's
 * answer, re-hashed before it resolves; blob-miss and blob errors reject.
 * Every non-blob message flows to the session unchanged.
 */
export function createBlobStore(inner: SyncTransport, docId: string): BlobStore {
  const pendingPuts = new Map<string, Array<{ resolve(digest: string): void; reject(error: Error): void }>>();
  const pendingGets = new Map<string, Array<{ resolve(bytes: Uint8Array): void; reject(error: Error): void }>>();
  const cache = new Map<string, Uint8Array>();
  let session: ((raw: string) => void) | undefined;

  const settlePuts = (digest: string, error?: Error): void => {
    const waiters = pendingPuts.get(digest) ?? [];
    pendingPuts.delete(digest);
    for (const waiter of waiters) { if (error) waiter.reject(error); else waiter.resolve(digest); }
  };

  const tap = (raw: string): void => {
    const message = decodeMessage(raw);
    if (!message || message.doc !== docId) { session?.(raw); return; }
    if (message.t === "blob-ok" && message.blob === undefined) {
      settlePuts(message.digest);
      return;
    }
    if (message.t === "blob-ok" && message.blob !== undefined) {
      const bytes = fromBase64(message.blob);
      void (async () => {
        const waiters = pendingGets.get(message.digest) ?? [];
        pendingGets.delete(message.digest);
        const actual = "sha256:" + toHex(await sha256(bytes));
        if (actual !== message.digest) { for (const waiter of waiters) waiter.reject(new Error(`digest mismatch: expected ${message.digest}, got ${actual}`)); return; }
        cache.set(message.digest, bytes);
        for (const waiter of waiters) waiter.resolve(bytes);
      })();
      return;
    }
    if (message.t === "blob-miss") {
      const waiters = pendingGets.get(message.digest) ?? [];
      pendingGets.delete(message.digest);
      for (const waiter of waiters) waiter.reject(new Error(`no blob ${message.digest}`));
      return;
    }
    if (message.t === "error" && message.code.startsWith("blob-")) {
      for (const [digest, waiters] of [...pendingGets]) { for (const waiter of waiters) waiter.reject(new Error(message.message ?? message.code)); pendingGets.delete(digest); }
      for (const digest of [...pendingPuts.keys()]) settlePuts(digest, new Error(message.message ?? message.code));
      return;
    }
    session?.(raw);
  };
  // The tap owns the transport from birth — blob replies arrive (and are
  // consumed) whether or not a session ever attaches.
  inner.onMessage(tap);

  return {
    transport: {
      send: (raw: string) => inner.send(raw),
      onMessage(handler) { session = handler; }, // the tap is already installed
      close: () => inner.close(),
    },
    put(bytes) {
      return new Promise<string>((resolve, reject) => {
        void (async () => {
          const digest = "sha256:" + toHex(await sha256(bytes));
          const waiters = pendingPuts.get(digest) ?? [];
          waiters.push({ resolve, reject });
          pendingPuts.set(digest, waiters);
          if (waiters.length === 1) inner.send(encodeMessage({ v: WIRE_VERSION, t: "blob-put", doc: docId, blob: toBase64(bytes) }));
        })().catch(reject);
      });
    },
    get(digest) {
      const cached = cache.get(digest);
      if (cached) return Promise.resolve(cached);
      return new Promise<Uint8Array>((resolve, reject) => {
        const waiters = pendingGets.get(digest) ?? [];
        waiters.push({ resolve, reject });
        pendingGets.set(digest, waiters);
        if (waiters.length === 1) inner.send(encodeMessage({ v: WIRE_VERSION, t: "blob-get", doc: docId, digest }));
      });
    },
  };
}
