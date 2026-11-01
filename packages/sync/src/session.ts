/**
 * Sync session — SYNC.md SW-3/SW-4/SW-7 from the client side.
 *
 * Bootstrap verification (SW-3): a delta is applied to a THROWAWAY copy of
 * the local document first, and to the real one only once verified. That
 * is how "discard on mismatch" is implemented — an applied CRDT update
 * cannot be un-applied, so it is never applied until verified. Open
 * documents check the claimed root digest; secured documents rebuild the
 * peer's state from its envelope log and accept a delta only when it adds
 * nothing the log (and this session's own unconfirmed outbox) does not
 * attest.
 */

import * as Y from "yjs";
import { isSecuredDocId, rootDigest, verifyCheckpoint } from "@nooq/core";
import { admitEnvelope, documentHeader, keepFormatting, newDocument, readState, restoreCheckpoint } from "@nooq/yjs";
import type { Envelope } from "@nooq/core";
import { fromBase64, toBase64 } from "./base64.ts";
import {
  BACKEND,
  decodeMessage,
  encodeMessage,
  WIRE_VERSION,
  type Cursor,
  type WireCheckpoint,
  type WireMessage,
} from "./messages.ts";
import type { SyncTransport } from "./transport.ts";

export const REMOTE_ORIGIN = "nooq-remote";
/** Updates applied by admitEnvelope already carried their envelope. */
export const ADMIT_ORIGIN = "nooq-admit";
/** Updates sealed by commitSigned carry this origin and are shipped by their committer. */
export const COMMIT_ORIGIN = "nooq-commit";

export interface AwarenessEntry {
  actor: string;
  name?: string | null;
  cursor: Cursor;
}

export interface SyncSessionOptions {
  doc: Y.Doc;
  transport: SyncTransport;
  actor: string;
  name?: string | null;
  cursor?: Cursor;
  onAwareness?: (entry: AwarenessEntry) => void;
  onError?: (error: { code: string; message?: string }) => void;
  onSynced?: () => void;
  /** SW-2: surfaces envelope verdicts (denied updates were dropped; held ones pend). */
  onAdmission?: (verdict: "allow" | "hold" | "deny", reason?: string) => void;
  /** SW-4: envelopes a previous session sent but no handshake confirmed (a host restores them). */
  outbox?: ReadonlyArray<OutboxEntry>;
  /**
   * DM-14.4: each peer envelope this session admits, and each one a verified
   * bootstrap log carries, for the host's history store. It may repeat an
   * envelope the host already has: dedupe by `updateDigest`.
   */
  onEnvelope?: (envelope: Envelope, update: Uint8Array) => void;
}

/** An envelope this session sent, kept until a handshake confirms the peer has it (SW-4). */
export interface OutboxEntry {
  envelope: Envelope;
  update: Uint8Array;
}

export class SyncSession {
  private readonly options: SyncSessionOptions;
  private transport: SyncTransport;
  private syncedFlag = false;
  private closed = false;
  /** DM-13: envelopes held pending grants; retried after every admission. */
  private readonly pending: Array<{ envelope: Envelope; update: Uint8Array }> = [];
  /** SW-4: sent envelopes awaiting confirmation; resent after every handshake. */
  private readonly outboxEntries: OutboxEntry[];
  /** Inbound document messages are handled in arrival order (a relayed burst admits in sequence). */
  private inbound: Promise<void> = Promise.resolve();
  private readonly handleTransportMessage: (raw: string) => void;
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(options: SyncSessionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.outboxEntries = [...(options.outbox ?? [])];
    this.handleTransportMessage = (raw) => this.receive(raw);
    this.handleDocUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN || origin === COMMIT_ORIGIN || origin === ADMIT_ORIGIN || this.closed) return;
      // COMMIT_ORIGIN updates are sealed and shipped by their committer;
      // ADMIT_ORIGIN updates arrived through envelopes and already ship.
      // Bare per-transaction increments (SW-4): idempotent, unordered,
      // and — since the header left the CRDT (SYNC Draft 1.2) — items
      // start at clock 0, so even a peer that missed our base integrates
      // or pends-until-base, both correct.
      this.send({ v: WIRE_VERSION, t: "update", doc: this.docId, update: toBase64(update) });
    };
    options.transport.onMessage(this.handleTransportMessage);
    options.doc.on("update", this.handleDocUpdate);
    keepFormatting(options.doc); // remote deltas never trigger unsigned local cleanup (DM-12)
  }

  /** SW-4: what still awaits confirmation — persist it to survive a restart. */
  get outbox(): ReadonlyArray<OutboxEntry> {
    return [...this.outboxEntries];
  }

  private get docId(): string {
    return documentHeader(this.options.doc).docId;
  }

  get synced(): boolean {
    return this.syncedFlag;
  }

  /**
   * SW-3: announce what we have (sv) and, in open documents, our state.
   * A secured document never sends unsigned state: its changes travel as
   * outbox envelopes, resent once the reply says what the peer lacks.
   */
  start(): void {
    const hasState = this.hasAnyState();
    const bare = hasState && !isSecuredDocId(this.docId);
    this.send({
      v: WIRE_VERSION,
      t: "hello",
      doc: this.docId,
      backend: BACKEND,
      sv: hasState ? toBase64(Y.encodeStateVector(this.options.doc)) : null,
      update: bare ? toBase64(Y.encodeStateAsUpdate(this.options.doc)) : null,
    });
  }

  /** SW-3: re-run the handshake, over a new transport when given (reconnect). */
  restart(transport?: SyncTransport): void {
    if (this.closed) throw new Error("a closed session cannot restart");
    if (transport && transport !== this.transport) {
      this.transport.close();
      this.transport = transport;
      transport.onMessage(this.handleTransportMessage);
    }
    this.syncedFlag = false;
    this.start();
  }

  /** SW-2/SW-4: ship an update; an envelope also waits in the outbox until confirmed. */
  sendUpdate(update: Uint8Array, envelope?: Envelope): void {
    if (envelope !== undefined) this.outboxEntries.push({ envelope, update });
    this.send({
      v: WIRE_VERSION,
      t: "update",
      doc: this.docId,
      update: toBase64(update),
      ...(envelope !== undefined ? { envelope } : {}),
    });
  }

  /** SW-7: announce a cursor (block identity + offset) or departure (null). */
  setCursor(cursor: Cursor): void {
    this.send({
      v: WIRE_VERSION,
      t: "awareness",
      doc: this.docId,
      actor: this.options.actor,
      ...(this.options.name !== undefined ? { name: this.options.name } : {}),
      cursor,
    });
  }

  close(): void {
    this.closed = true;
    this.options.doc.off("update", this.handleDocUpdate);
    this.transport.close();
  }

  /** Disconnected is the default state (§2): a failed send waits for the next handshake. */
  private send(message: WireMessage): void {
    try {
      this.transport.send(encodeMessage(message));
    } catch {
      // The outbox still holds every envelope; nothing else needs delivery.
    }
  }

  /** SW-4: drop what the reply confirms, resend the rest (returned: the bootstrap check needs them). */
  private flushOutbox(reply: Extract<WireMessage, { t: "hello-reply" }>): OutboxEntry[] {
    const known = Y.decodeStateVector(fromBase64(reply.sv));
    const logged = new Set((reply.envelopes ?? []).map((item) => item.envelope.updateDigest));
    const unconfirmed = this.outboxEntries.filter(({ envelope }) => {
      if (logged.has(envelope.updateDigest)) return false;
      const carriesStructs = envelope.clocks.to >= envelope.clocks.from;
      return !(carriesStructs && (known.get(envelope.client) ?? 0) > envelope.clocks.to);
    });
    this.outboxEntries.length = 0;
    this.outboxEntries.push(...unconfirmed);
    for (const { envelope, update } of unconfirmed) {
      this.send({ v: WIRE_VERSION, t: "update", doc: this.docId, update: toBase64(update), envelope });
    }
    return unconfirmed;
  }

  private hasAnyState(): boolean {
    return Y.encodeStateVector(this.options.doc).length > 2;
  }

  private receive(raw: string): void {
    if (this.closed) return;
    const message = decodeMessage(raw);
    if (!message) return;
    if (message.doc !== this.docId) {
      this.options.onError?.({ code: "bad-doc", message: `message for ${message.doc}` });
      return;
    }
    switch (message.t) {
      case "hello-reply":
        this.inOrder(() => this.bootstrap(message));
        return;
      case "update":
        this.inOrder(() => this.receiveUpdate(message.update, message.envelope));
        return;
      case "delta":
        if (message.delta !== undefined) this.inOrder(() => this.receiveDelta(message.delta!, message.rootDigest ?? null));
        return;
      case "awareness":
        this.options.onAwareness?.({ actor: message.actor, name: message.name ?? null, cursor: message.cursor });
        return;
      case "error":
        this.options.onError?.({ code: message.code, message: message.message });
        return;
      case "hello":
        return; // sessions do not act as relays
    }
  }

  private inOrder(task: () => Promise<void>): void {
    this.inbound = this.inbound.then(task).catch((cause) => {
      this.options.onError?.({ code: "receive-failed", message: cause instanceof Error ? cause.message : String(cause) });
    });
  }

  private async receiveUpdate(updateB64: string, envelope?: Envelope): Promise<void> {
    const update = fromBase64(updateB64);
    if (envelope) {
      const admission = await admitEnvelope(this.options.doc, envelope, update);
      this.options.onAdmission?.(admission.verdict, admission.reason);
      if (admission.verdict === "deny") return; // never applied (DM-13)
      if (admission.verdict === "hold") {
        this.pending.push({ envelope, update });
        return;
      }
      this.options.onEnvelope?.(envelope, update);
      await this.retryPending();
      return;
    }
    // Bare update: legal only in open documents (SW-2/DM-13).
    if (readState(this.options.doc).access) {
      this.options.onAdmission?.("deny", "unsigned update in an access-controlled document");
      return;
    }
    Y.applyUpdate(this.options.doc, update, REMOTE_ORIGIN);
  }

  /** Retry held envelopes until none admits: one release can unblock the next. */
  private async retryPending(): Promise<void> {
    for (let progress = true; progress && this.pending.length > 0;) {
      progress = false;
      const remaining: Array<{ envelope: Envelope; update: Uint8Array }> = [];
      for (const item of this.pending) {
        const admission = await admitEnvelope(this.options.doc, item.envelope, item.update);
        if (admission.verdict === "hold") remaining.push(item);
        else if (admission.verdict === "allow") {
          progress = true;
          this.options.onEnvelope?.(item.envelope, item.update);
        }
      }
      this.pending.length = 0;
      this.pending.push(...remaining);
    }
  }

  private async bootstrap(message: Extract<WireMessage, { t: "hello-reply" }>): Promise<void> {
    if (message.backend !== BACKEND) {
      this.options.onError?.({ code: "backend-mismatch", message: `unsupported backend ${message.backend}` });
      return;
    }
    const unconfirmed = this.flushOutbox(message);
    if (message.delta === null) {
      this.markSynced();
      return;
    }
    const delta = fromBase64(message.delta);
    const verified = isSecuredDocId(this.docId)
      ? await this.verifyAgainstLog(delta, message.rootDigest, message.envelopes ?? [], unconfirmed, message.checkpoint)
      : await this.verifyAgainstDigest(delta, message.rootDigest);
    if (!verified) return; // discard: never applied to the real document
    Y.applyUpdate(this.options.doc, delta, REMOTE_ORIGIN);
    for (const item of message.envelopes ?? []) this.options.onEnvelope?.(item.envelope, fromBase64(item.update));
    await this.retryPending();
    this.markSynced();
  }

  /** SW-4: a bare delta reply — checked like a bootstrap delta, never trusted. */
  private async receiveDelta(deltaB64: string, claimed: string | null): Promise<void> {
    if (isSecuredDocId(this.docId)) {
      this.options.onAdmission?.("deny", "unsigned delta in a secured document");
      return;
    }
    const delta = fromBase64(deltaB64);
    if (await this.verifyAgainstDigest(delta, claimed)) Y.applyUpdate(this.options.doc, delta, REMOTE_ORIGIN);
  }

  /** Open documents (SW-3): local state plus the delta must project to the claimed root digest. */
  private async verifyAgainstDigest(delta: Uint8Array, claimed: string | null): Promise<boolean> {
    if (claimed === null) return true;
    const scratch = this.copyOfLocal();
    Y.applyUpdate(scratch, delta);
    const actual = await rootDigest(readState(scratch));
    if (actual === claimed) return true;
    this.options.onError?.({ code: "verification-failed", message: `bootstrap digest mismatch: claimed ${claimed}, projected ${actual}` });
    return false;
  }

  /**
   * Secured documents (SW-3): rebuild the peer's state from its checkpoint
   * (DM-15: signature, grant, owner-proven access, reproduced digest) or from
   * genesis, then every envelope after it, and check its digest claim.
   * Then local state plus the delta must equal that state plus this
   * session's unconfirmed outbox, byte for byte: the delta may carry nothing
   * the log does not attest, and offline edits are expected, not a mismatch.
   */
  private async verifyAgainstLog(
    delta: Uint8Array,
    claimed: string | null,
    envelopes: ReadonlyArray<{ envelope: Envelope; update: string }>,
    unconfirmed: ReadonlyArray<OutboxEntry>,
    checkpoint?: WireCheckpoint,
  ): Promise<boolean> {
    const fail = (code: string, message: string) => {
      this.options.onError?.({ code, message });
      return false;
    };
    let attested = newDocument(this.docId);
    if (checkpoint) {
      const restored = await restoreCheckpoint(this.docId, checkpoint.checkpoint, fromBase64(checkpoint.state));
      if (!restored) return fail("checkpoint-invalid", "checkpoint state does not reproduce its digest");
      const verdict = await verifyCheckpoint(checkpoint.checkpoint, { docId: this.docId, access: readState(restored).access, accessProof: checkpoint.accessProof });
      if (!verdict.ok) return fail("checkpoint-invalid", verdict.reason);
      attested = restored;
    }
    for (const item of envelopes) {
      const admission = await admitEnvelope(attested, item.envelope, fromBase64(item.update));
      if (admission.verdict !== "allow") return fail("envelope-log-invalid", `bootstrap envelope log: ${admission.reason}`);
    }
    if (claimed !== null) {
      const actual = await rootDigest(readState(attested));
      if (actual !== claimed) return fail("verification-failed", `bootstrap digest mismatch: claimed ${claimed}, log projects ${actual}`);
    }
    for (const { envelope, update } of unconfirmed) await admitEnvelope(attested, envelope, update);
    const candidate = this.copyOfLocal();
    Y.applyUpdate(candidate, delta);
    if (!sameBytes(Y.encodeStateAsUpdate(candidate), Y.encodeStateAsUpdate(attested))) {
      return fail("envelope-log-mismatch", "bootstrap delta disagrees with its envelope log");
    }
    return true;
  }

  private copyOfLocal(): Y.Doc {
    const scratch = newDocument(this.docId); // same classification as every peer (DM-12)
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.options.doc));
    return scratch;
  }

  private markSynced(): void {
    if (this.syncedFlag) return;
    this.syncedFlag = true;
    this.options.onSynced?.();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
