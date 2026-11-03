/**
 * The hosted peer, in miniature — SYNC.md SW-6.
 *
 * An in-memory relay that does exactly what a nooq sync service MAY do
 * (persist per document, serve hello-reply deltas, relay updates
 * unchanged) and nothing it MUST NOT (no content gating, no resolving).
 * Used by the test suite and as the reference loopback binding (SW-8).
 */

import * as Y from "yjs";
import { checkpointId, checkpointSignerKey, rootDigest, sha256, toBase64 as keyToBase64, toHex, type ActorKey, type Checkpoint, type Envelope } from "@nooq/core";
import { admitEnvelope, createCheckpoint, newDocument, readState } from "@nooq/yjs";
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
  /**
   * DM-15: the relay's checkpoint signer, granted the `checkpointer` role (or
   * writer) in each document it attests. It checkpoints every `every`
   * envelopes (1,000) or `bytes` of envelope log (1 MiB), whichever is first.
   */
  checkpointer?: { actorId: string; key: ActorKey; every?: number; bytes?: number };
}

interface Attested {
  checkpoint: Checkpoint;
  state: Uint8Array;
  /** Envelopes before this index are covered: archive, not shipped to joiners. */
  logIndex: number;
  accessProof: Envelope;
}

interface HeldEnvelope {
  envelope: Envelope;
  update: Uint8Array;
  raw: string;
  heldAt: number;
}

export class NooqRelay {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly connections = new Map<string, Set<SyncTransport>>();
  /** DM-12/SW-3: the envelope log per document, in admission order. */
  private readonly envelopeLog = new Map<string, Array<{ envelope: Envelope; update: Uint8Array }>>();
  /** DM-13: validly signed envelopes awaiting grants. */
  private readonly held = new Map<string, HeldEnvelope[]>();
  /** SW-6: update digests already admitted — each update is logged and relayed once. */
  private readonly admitted = new Map<string, Set<string>>();
  /** Messages per document are handled in arrival order, so a burst admits in sequence. */
  private readonly queues = new Map<string, Promise<void>>();
  /** DM-15: the latest checkpoint per document, and the log since it. */
  private readonly attested = new Map<string, Attested>();
  private readonly sinceCheckpoint = new Map<string, { count: number; bytes: number }>();
  /** The latest owner-signed access write per document: proof of a checkpoint signer's grant. */
  private readonly accessProofs = new Map<string, Envelope>();

  constructor(private readonly options: NooqRelayOptions = {}) {}

  /** Connect a client transport to a hosted document. */
  connect(docId: string): SyncTransport {
    const { client, server } = createDuplex();
    server.onMessage((raw) => {
      // Arrival order: an outbox burst's later envelopes depend on earlier
      // ones, and a held envelope is only retried after a later admission.
      const next = (this.queues.get(docId) ?? Promise.resolve()).then(() => this.handle(docId, server, raw)).catch(() => {});
      this.queues.set(docId, next);
    });
    return client;
  }

  /** The relay's persisted view, for tests. */
  stored(docId: string): Y.Doc | undefined {
    return this.docs.get(docId);
  }

  /** Draft 3.3 observability (SW-6, proposals/0011): holds and evictions are countable, never silent. */
  heldCount(docId: string): number { return this.held.get(docId)?.length ?? 0; }
  evictionCounters(): { age: number; count: number } { return { ...this.evictions }; }

  /** @internal test seam: evict holds older than `maxAgeMs` (default: the SW-6 bound). */
  evictAllAged(docId: string, maxAgeMs = 10 * 60_000): void {
    const held = this.held.get(docId);
    if (held) { this.evictAged(docId, held); this.evictOlderThan(held, maxAgeMs); }
  }
  private evictOlderThan(held: HeldEnvelope[], maxAgeMs: number): void {
    const now = Date.now();
    while (held.length > 0 && now - held[0]!.heldAt > maxAgeMs) { held.shift(); this.evictions.age++; }
  }

  /** @internal test seam: stress the count bound directly. */
  floodHolds(docId: string, n: number): void {
    let held = this.held.get(docId);
    if (!held) { held = []; this.held.set(docId, held); }
    for (let i = 0; i < n; i++) held.push({ envelope: { updateDigest: `flood-${docId}-${i}` } as Envelope, update: new Uint8Array(), raw: "", heldAt: Date.now() });
    while (held.length > 1_024) { held.shift(); this.evictions.count++; }
  }

  envelopesOf(docId: string): Array<{ envelope: Envelope; update: Uint8Array }> {
    return this.envelopeLog.get(docId) ?? [];
  }

  /** The latest checkpoint, for tests and hosts. */
  checkpointOf(docId: string): Checkpoint | undefined {
    return this.attested.get(docId)?.checkpoint;
  }

  /** DM-15: attest the current state once enough log has accumulated since the last checkpoint. */
  private async maybeCheckpoint(docId: string): Promise<void> {
    const signer = this.options.checkpointer;
    const doc = this.docs.get(docId);
    const since = this.sinceCheckpoint.get(docId);
    if (!signer || !doc || !since) return;
    if (since.count < (signer.every ?? 1000) && since.bytes < (signer.bytes ?? 1 << 20)) return;
    const access = readState(doc).access;
    const accessProof = this.accessProofs.get(docId);
    if (!access || !accessProof || checkpointSignerKey(access, signer.actorId) !== keyToBase64(signer.key.publicBytes)) return; // not granted here
    const last = this.attested.get(docId);
    const logIndex = this.envelopeLog.get(docId)!.length;
    const { checkpoint, state } = await createCheckpoint(doc, signer, last ? await checkpointId(last.checkpoint) : null);
    this.attested.set(docId, { checkpoint, state, logIndex, accessProof });
    this.sinceCheckpoint.set(docId, { count: 0, bytes: 0 });
  }

  /**
   * Verify then admit, exactly like any peer (SW-6). A duplicate (an update
   * already admitted) changes nothing and is neither logged nor relayed.
   */
  /** 0014: the blob store — bytes by digest, deduplicated by content. */
  readonly #blobs = new Map<string, Uint8Array>();
  /** The per-blob cap (0014): 10 MiB; bigger uploads are refused, named. */
  static readonly BLOB_LIMIT = 10 * 1024 * 1024;
  /** Test seam: distinct blobs stored (dedup counts once). */
  blobCount(): number { return this.#blobs.size; }

  private serveBlob(message: { t: "blob-put" | "blob-get"; doc: string; blob?: string; digest?: string }, server: SyncTransport): void {
    if (message.t === "blob-put") {
      const bytes = fromBase64(message.blob ?? "");
      if (bytes.byteLength === 0 || bytes.byteLength > NooqRelay.BLOB_LIMIT) {
        server.send(encodeMessage(errorFor(message.doc, "blob-size", `blobs are 1 byte to ${NooqRelay.BLOB_LIMIT} bytes`)));
        return;
      }
      void (async () => {
        const digest = "sha256:" + toHex(await sha256(bytes));
        if (!this.#blobs.has(digest)) this.#blobs.set(digest, bytes); // dedup by content
        server.send(encodeMessage({ v: 1, t: "blob-ok", doc: message.doc, digest }));
      })();
      return;
    }
    const bytes = this.#blobs.get(message.digest ?? "");
    server.send(bytes === undefined
      ? encodeMessage({ v: 1, t: "blob-miss", doc: message.doc, digest: message.digest ?? "" })
      : encodeMessage({ v: 1, t: "blob-ok", doc: message.doc, digest: message.digest ?? "", blob: toBase64(bytes) }));
  }

  private async verifyAndAdmit(docId: string, envelope: Envelope, update: Uint8Array, raw: string): Promise<"allow" | "hold" | "deny" | "duplicate"> {
    const doc = this.docs.get(docId) ?? this.open(docId);
    const admitted = this.admitted.get(docId)!;
    const admission = await admitEnvelope(doc, envelope, update);
    if (admission.verdict === "allow") {
      if (admission.reason === "duplicate" || admitted.has(envelope.updateDigest)) return "duplicate";
      admitted.add(envelope.updateDigest);
      this.envelopeLog.get(docId)!.push({ envelope, update });
      if (admission.touched?.accessWrites) this.accessProofs.set(docId, envelope);
      const since = this.sinceCheckpoint.get(docId)!;
      since.count++;
      since.bytes += update.length;
      return "allow";
    }
    if (admission.verdict === "hold") {
      const held = this.held.get(docId)!;
      if (!held.some((item) => item.envelope.updateDigest === envelope.updateDigest)) {
        held.push({ envelope, update, raw, heldAt: Date.now() });
        // SYNC Draft 3.3 (SW-6, proposals/0011): holds bounded by age and
        // count; eviction changes no verdict and is counted, never silent.
        this.evictAged(docId, held);
        while (held.length > 1_024) { held.shift(); this.evictions.count++; }
      }
      return "hold";
    }
    return "deny";
  }

  /** Draft 3.3: age-bounded eviction per document. */
  private evictAged(docId: string, held: HeldEnvelope[]): void {
    const now = Date.now();
    while (held.length > 0 && now - held[0]!.heldAt > 10 * 60_000) {
      held.shift();
      this.evictions.age++;
    }
  }

  readonly evictions = { age: 0, count: 0 };

  /** Re-evaluate held envelopes after any admission (grants or predecessors may have arrived), until none admits. */
  private async releaseHeld(docId: string, server: SyncTransport): Promise<void> {
    for (let progress = true; progress;) {
      progress = false;
      const queue = this.held.get(docId) ?? [];
      this.evictAged(docId, queue);
      const remaining: HeldEnvelope[] = [];
      for (const item of queue) {
        const verdict = await this.verifyAndAdmit(docId, item.envelope, item.update, item.raw);
        if (verdict === "allow") {
          progress = true;
          for (const peer of this.connections.get(docId)!) {
            if (peer !== server) peer.send(item.raw); // released: relay like any update
          }
        } else if (verdict === "hold") {
          remaining.push(item);
        } // deny: dropped for good; duplicate: already relayed once
      }
      this.held.set(docId, remaining);
    }
  }

  private async handle(docId: string, server: SyncTransport, raw: string): Promise<void> {
    const message = decodeMessage(raw);
    if (!message) return; // unknown envelope: ignore (SW-2)
    // 0014: blobs are not transactions — unsigned, content-addressed, inert;
    // the digest IS the authenticity. Never inside the CRDT, never a verdict.
    if (message.t === "blob-put" || message.t === "blob-get") {
      this.serveBlob(message, server);
      return;
    }
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
          let relay = true;
          if (message.envelope) {
            const verdict = await this.verifyAndAdmit(docId, message.envelope, fromBase64(message.update), raw);
            if (verdict === "deny") {
              server.send(encodeMessage(errorFor(docId, "envelope-denied", "hello update failed verification")));
              return;
            }
            relay = verdict === "allow"; // held or duplicate: not relayed (SW-6)
          } else if (readState(doc).access) {
            server.send(encodeMessage(errorFor(docId, "envelope-denied", "unsigned hello update in an access-controlled document")));
            return;
          } else {
            Y.applyUpdate(doc, fromBase64(message.update), "relay-store");
          }
          for (const peer of relay ? this.connections.get(docId)! : []) {
            if (peer !== server) {
              peer.send(encodeMessage({ v: 1, t: "update", doc: docId, update: message.update, ...(message.envelope ? { envelope: message.envelope } : {}) }));
            }
          }
        }
        const sv = message.sv === null ? undefined : fromBase64(message.sv);
        const delta = toBase64(Y.encodeStateAsUpdate(doc, sv));
        const digest = await rootDigest(readState(doc));
        // SW-3: the latest checkpoint and the envelopes after it; covered envelopes are archive.
        const point = this.attested.get(docId);
        const log = (this.envelopeLog.get(docId) ?? []).slice(point?.logIndex ?? 0);
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
            ...(point ? { checkpoint: { checkpoint: point.checkpoint, state: toBase64(point.state), accessProof: point.accessProof } } : {}),
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
          if (verdict === "duplicate") return; // already logged and relayed once (SW-6)
          for (const peer of this.connections.get(docId)!) {
            if (peer !== server) peer.send(raw); // relay unchanged (SW-6)
          }
          await this.releaseHeld(docId, server);
          await this.maybeCheckpoint(docId);
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
    const doc = newDocument(docId); // same classification as every peer (DM-12); side-channel header (SYNC Draft 1.2)
    this.docs.set(docId, doc);
    this.connections.set(docId, this.connections.get(docId) ?? new Set());
    this.envelopeLog.set(docId, this.envelopeLog.get(docId) ?? []);
    this.held.set(docId, this.held.get(docId) ?? []);
    this.admitted.set(docId, this.admitted.get(docId) ?? new Set());
    this.sinceCheckpoint.set(docId, this.sinceCheckpoint.get(docId) ?? { count: 0, bytes: 0 });
    return doc;
  }
}
