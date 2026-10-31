/**
 * The hosted peer, in miniature — SYNC.md SW-6.
 *
 * An in-memory relay that does exactly what a nooq sync service MAY do
 * (persist per document, serve hello-reply deltas, relay updates
 * unchanged) and nothing it MUST NOT (no content gating, no resolving).
 * Used by the test suite and as the reference loopback binding (SW-8).
 */

import * as Y from "yjs";
import { rootDigest } from "@nooq/core";
import { readState, registerHeader } from "@nooq/yjs";
import { fromBase64, toBase64 } from "./base64.ts";
import { BACKEND, decodeMessage, encodeMessage, errorFor } from "./messages.ts";
import type { SyncTransport } from "./transport.ts";

interface Connection {
  client: SyncTransport;
  server: SyncTransport;
}

/** Two transports wired back to back, delivering on microtasks. */
function createDuplex(): Connection {
  let clientHandler: ((raw: string) => void) | undefined;
  let serverHandler: ((raw: string) => void) | undefined;
  const client: SyncTransport = {
    send: (raw) => queueMicrotask(() => serverHandler?.(raw)),
    onMessage: (handler) => (clientHandler = handler),
    close: () => (clientHandler = undefined),
  };
  const server: SyncTransport = {
    send: (raw) => queueMicrotask(() => clientHandler?.(raw)),
    onMessage: (handler) => (serverHandler = handler),
    close: () => (serverHandler = undefined),
  };
  return { client, server };
}

export interface NooqRelayOptions {
  /** Lie about the root digest in hello-reply — for the verification test. Off, obviously. */
  lieAboutDigest?: boolean;
}

export class NooqRelay {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly connections = new Map<string, Set<SyncTransport>>();

  constructor(private readonly options: NooqRelayOptions = {}) {}

  /** Connect a client transport to a hosted document. */
  connect(docId: string): SyncTransport {
    const { client, server } = createDuplex();
    server.onMessage((raw) => {
      void this.handle(docId, server, raw);
    });
    return client;
  }

  /** The relay's persisted view, for tests. */
  stored(docId: string): Y.Doc | undefined {
    return this.docs.get(docId);
  }

  private async handle(docId: string, server: SyncTransport, raw: string): Promise<void> {
    const message = decodeMessage(raw);
    if (!message) return; // unknown envelope: ignore (SW-2)
    if (message.doc !== docId) {
      server.send(encodeMessage(errorFor(message.doc, "bad-doc", `this session serves ${docId}`)));
      return;
    }
    switch (message.t) {
      case "hello": {
        if (message.backend !== BACKEND) {
          server.send(encodeMessage(errorFor(docId, "backend-mismatch", `unsupported backend ${message.backend}`)));
          return;
        }
        const doc = this.docs.get(docId) ?? this.open(docId);
        // Draft 1.1: apply the client's full state BEFORE computing the
        // reply, so the handshake alone converges both directions (SW-3).
        // Draft 1.2: the hello's payload is an update like any other —
        // relay it to existing sessions so they learn the joiner's base
        // (clocks 0..n); without it, the joiner's later increments would
        // pend on peers that never saw them (SW-6).
        if (message.update) {
          Y.applyUpdate(doc, fromBase64(message.update), "relay-store");
          for (const peer of this.connections.get(docId)!) {
            if (peer !== server) {
              peer.send(encodeMessage({ v: 1, t: "update", doc: docId, update: message.update }));
            }
          }
        }
        const sv = message.sv === null ? undefined : fromBase64(message.sv);
        const delta = toBase64(Y.encodeStateAsUpdate(doc, sv));
        const digest = await rootDigest(readState(doc));
        this.connections.get(docId)!.add(server);
        server.send(
          encodeMessage({
            v: 1,
            t: "hello-reply",
            doc: docId,
            backend: BACKEND,
            sv: toBase64(Y.encodeStateVector(doc)),
            delta,
            rootDigest: this.options.lieAboutDigest ? "sha256:" + "0".repeat(64) : digest,
          }),
        );
        return;
      }
      case "update": {
        const doc = this.docs.get(docId) ?? this.open(docId);
        Y.applyUpdate(doc, fromBase64(message.update), "relay-store");
        for (const peer of this.connections.get(docId)!) {
          if (peer !== server) peer.send(raw); // relay unchanged (SW-6)
        }
        return;
      }
      case "delta": {
        if (message.sv === undefined) return; // a bare reply has nothing to answer
        const doc = this.docs.get(docId) ?? this.open(docId);
        // sv null means "send everything", same as a fresh hello (SW-4).
        const delta = toBase64(Y.encodeStateAsUpdate(doc, message.sv === null ? undefined : fromBase64(message.sv)));
        server.send(
          encodeMessage({ v: 1, t: "delta", doc: docId, delta, rootDigest: await rootDigest(readState(doc)) }),
        );
        return;
      }
      case "awareness": {
        for (const peer of this.connections.get(docId) ?? []) {
          if (peer !== server) peer.send(raw);
        }
        return;
      }
      case "hello-reply":
      case "error":
        return; // clients do not receive these from peers
    }
  }

  private open(docId: string): Y.Doc {
    const doc = new Y.Doc();
    registerHeader(doc, { docId, schemaVersion: 1 }); // side-channel header (SYNC Draft 1.2)
    this.docs.set(docId, doc);
    this.connections.set(docId, this.connections.get(docId) ?? new Set());
    return doc;
  }
}
