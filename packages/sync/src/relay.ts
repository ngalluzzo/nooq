/**
 * The hosted peer, in miniature — SYNC.md SW-6.
 *
 * An in-memory relay that does exactly what a nooq sync service MAY do
 * (persist per document, serve hello-reply deltas, relay updates
 * unchanged) and nothing it MUST NOT (no content gating, no resolving).
 * Used by the test suite and as the reference loopback binding (SW-8).
 */

import * as Y from "yjs";
import { rootDigest, type Envelope } from "@nooq/core";
import { admitEnvelope, readState, registerHeader } from "@nooq/yjs";
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

interface HeldEnvelope {
  envelope: Envelope;
  update: Uint8Array;
  raw: string;
}

export class NooqRelay {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly connections = new Map<string, Set<SyncTransport>>();
  /** DM-12/SW-3: the envelope log per document, in admission order. */
  private readonly envelopeLog = new Map<string, Array<{ envelope: Envelope; update: Uint8Array }>>();
  /** DM-13: validly signed envelopes awaiting grants. */
  private readonly held = new Map<string, HeldEnvelope[]>();

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

  envelopesOf(docId: string): Array<{ envelope: Envelope; update: Uint8Array }> {
    return this.envelopeLog.get(docId) ?? [];
  }

  /** Verify then admit, exactly like any peer (SW-6). Returns the verdict. */
  private async verifyAndAdmit(docId: string, envelope: Envelope, update: Uint8Array, raw: string): Promise<"allow" | "hold" | "deny"> {
    const doc = this.docs.get(docId) ?? this.open(docId);
    const admission = await admitEnvelope(doc, envelope, update);
    if (admission.verdict === "allow") {
      this.envelopeLog.get(docId)!.push({ envelope, update });
      return "allow";
    }
    if (admission.verdict === "hold") {
      this.held.get(docId)!.push({ envelope, update, raw });
      return "hold";
    }
    return "deny";
  }

  /** Re-evaluate held envelopes after any admission (grants may have arrived). */
  private async releaseHeld(docId: string, server: SyncTransport): Promise<void> {
    const queue = this.held.get(docId);
    if (!queue || queue.length === 0) return;
    const remaining: HeldEnvelope[] = [];
    for (const item of queue) {
      const verdict = await this.verifyAndAdmit(docId, item.envelope, item.update, item.raw);
      if (verdict === "allow") {
        for (const peer of this.connections.get(docId)!) {
          if (peer !== server) peer.send(item.raw); // released: relay like any update
        }
      } else if (verdict === "hold") {
        remaining.push(item);
      } // deny: dropped for good
    }
    this.held.set(docId, remaining);
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
        // Register BEFORE any await: updates arriving while we compute the
        // reply must already be forwarded to this connection (race fix).
        this.connections.get(docId)!.add(server);
        // Draft 1.1: apply the client's full state BEFORE computing the
        // reply, so the handshake alone converges both directions (SW-3).
        // Draft 1.2: the hello's payload is an update like any other —
        // relay it to existing sessions so they learn the joiner's base.
        // Draft 2: in access-controlled documents a bare hello update is
        // refused like any bare update — state cannot bypass the rules.
        if (message.update) {
          if (message.envelope) {
            const verdict = await this.verifyAndAdmit(docId, message.envelope, fromBase64(message.update), raw);
            if (verdict === "deny") {
              server.send(encodeMessage(errorFor(docId, "envelope-denied", "hello update failed verification")));
              return;
            }
          } else if (readState(doc).access) {
            server.send(encodeMessage(errorFor(docId, "envelope-denied", "unsigned hello update in an access-controlled document")));
            return;
          } else {
            Y.applyUpdate(doc, fromBase64(message.update), "relay-store");
          }
          for (const peer of this.connections.get(docId)!) {
            if (peer !== server) {
              peer.send(encodeMessage({ v: 1, t: "update", doc: docId, update: message.update, ...(message.envelope ? { envelope: message.envelope } : {}) }));
            }
          }
        }
        const sv = message.sv === null ? undefined : fromBase64(message.sv);
        const delta = toBase64(Y.encodeStateAsUpdate(doc, sv));
        const digest = await rootDigest(readState(doc));
        const log = this.envelopeLog.get(docId) ?? [];
        server.send(
          encodeMessage({
            v: 1,
            t: "hello-reply",
            doc: docId,
            backend: BACKEND,
            sv: toBase64(Y.encodeStateVector(doc)),
            delta,
            rootDigest: this.options.lieAboutDigest ? "sha256:" + "0".repeat(64) : digest,
            ...(log.length > 0 ? { envelopes: log.map(({ envelope, update }) => ({ envelope, update: toBase64(update) })) } : {}),
          }),
        );
        return;
      }
      case "update": {
        const doc = this.docs.get(docId) ?? this.open(docId);
        if (message.envelope) {
          // DM-12/13: verify like any peer; invalid envelopes are never
          // applied or relayed (SW-6).
          const verdict = await this.verifyAndAdmit(docId, message.envelope, fromBase64(message.update), raw);
          if (verdict === "deny") {
            server.send(encodeMessage(errorFor(docId, "envelope-denied", "update failed verification or authorization")));
            return;
          }
          if (verdict === "hold") return; // held pending grants; not relayed yet
          for (const peer of this.connections.get(docId)!) {
            if (peer !== server) peer.send(raw); // relay unchanged (SW-6)
          }
          await this.releaseHeld(docId, server);
          return;
        }
        // Open documents accept bare updates (SW-2); access-controlled
        // documents never do — unsigned state cannot bypass the rules.
        if (readState(doc).access) {
          server.send(encodeMessage(errorFor(docId, "envelope-denied", "unsigned update in an access-controlled document")));
          return;
        }
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
    const doc = new Y.Doc({ gc: false }); // same classification as every peer (DM-12)
    registerHeader(doc, { docId, schemaVersion: 1 }); // side-channel header (SYNC Draft 1.2)
    this.docs.set(docId, doc);
    this.connections.set(docId, this.connections.get(docId) ?? new Set());
    this.envelopeLog.set(docId, this.envelopeLog.get(docId) ?? []);
    this.held.set(docId, this.held.get(docId) ?? []);
    return doc;
  }
}
