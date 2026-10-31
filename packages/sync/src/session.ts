/**
 * Sync session — SYNC.md SW-3/SW-4/SW-7 from the client side.
 *
 * Bootstrap verification (SW-3): a hello-reply delta with a rootDigest
 * claim is applied to a THROWAWAY copy of the local document first; only
 * if the copy projects to the claimed digest is the delta applied for
 * real. That is how "discard on mismatch" is implemented — an applied
 * CRDT update cannot be un-applied, so it is never applied until
 * verified.
 */

import * as Y from "yjs";
import { rootDigest } from "@nooq/core";
import { admitEnvelope, documentHeader, readState, registerHeader } from "@nooq/yjs";
import type { Envelope } from "@nooq/core";
import { fromBase64, toBase64 } from "./base64.ts";
import {
  BACKEND,
  decodeMessage,
  encodeMessage,
  WIRE_VERSION,
  type Cursor,
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
}

export class SyncSession {
  private readonly options: SyncSessionOptions;
  private syncedFlag = false;
  private closed = false;
  /** DM-13: envelopes held pending grants; retried after every admission. */
  private readonly pending: Array<{ envelope: Envelope; update: Uint8Array }> = [];
  private readonly handleTransportMessage: (raw: string) => void;
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(options: SyncSessionOptions) {
    this.options = options;
    this.handleTransportMessage = (raw) => this.receive(raw);
    this.handleDocUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN || origin === COMMIT_ORIGIN || origin === ADMIT_ORIGIN || this.closed) return;
      // COMMIT_ORIGIN updates are sealed and shipped by their committer;
      // ADMIT_ORIGIN updates arrived through envelopes and already ship.
      // Bare per-transaction increments (SW-4): idempotent, unordered,
      // and — since the header left the CRDT (SYNC Draft 1.2) — items
      // start at clock 0, so even a peer that missed our base integrates
      // or pends-until-base, both correct.
      this.options.transport.send(
        encodeMessage({ v: WIRE_VERSION, t: "update", doc: this.docId, update: toBase64(update) }),
      );
    };
    options.transport.onMessage(this.handleTransportMessage);
    options.doc.on("update", this.handleDocUpdate);
  }

  private get docId(): string {
    return documentHeader(this.options.doc).docId;
  }

  get synced(): boolean {
    return this.syncedFlag;
  }

  /** SW-3: announce everything we have — our state (update) and what we want back (sv). */
  start(): void {
    const hasState = this.hasAnyState();
    this.options.transport.send(
      encodeMessage({
        v: WIRE_VERSION,
        t: "hello",
        doc: this.docId,
        backend: BACKEND,
        sv: hasState ? toBase64(Y.encodeStateVector(this.options.doc)) : null,
        update: hasState ? toBase64(Y.encodeStateAsUpdate(this.options.doc)) : null,
      }),
    );
  }

  /** SW-2: ship an update, optionally sealed in its envelope (DM-12). */
  sendUpdate(update: Uint8Array, envelope?: Envelope): void {
    this.options.transport.send(
      encodeMessage({
        v: WIRE_VERSION,
        t: "update",
        doc: this.docId,
        update: toBase64(update),
        ...(envelope !== undefined ? { envelope } : {}),
      }),
    );
  }

  /** SW-7: announce a cursor (block identity + offset) or departure (null). */
  setCursor(cursor: Cursor): void {
    this.options.transport.send(
      encodeMessage({
        v: WIRE_VERSION,
        t: "awareness",
        doc: this.docId,
        actor: this.options.actor,
        ...(this.options.name !== undefined ? { name: this.options.name } : {}),
        cursor,
      }),
    );
  }

  close(): void {
    this.closed = true;
    this.options.doc.off("update", this.handleDocUpdate);
    this.options.transport.close();
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
        void this.bootstrap(message);
        return;
      case "update":
        void this.receiveUpdate(message.update, message.envelope);
        return;
      case "delta":
        if (message.delta !== undefined) {
          Y.applyUpdate(this.options.doc, fromBase64(message.delta), REMOTE_ORIGIN);
        }
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

  private async retryPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const remaining: Array<{ envelope: Envelope; update: Uint8Array }> = [];
    for (const item of this.pending) {
      const admission = await admitEnvelope(this.options.doc, item.envelope, item.update);
      if (admission.verdict === "hold") remaining.push(item);
    }
    this.pending.length = 0;
    this.pending.push(...remaining);
  }

  private async bootstrap(message: Extract<WireMessage, { t: "hello-reply" }>): Promise<void> {
    if (message.backend !== BACKEND) {
      this.options.onError?.({ code: "backend-mismatch", message: `unsupported backend ${message.backend}` });
      return;
    }
    if (message.delta === null) {
      this.markSynced();
      return;
    }
    const claimed = message.rootDigest;
    if (claimed !== null) {
      // Verify against a throwaway copy before committing (SW-3).
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.options.doc));
      Y.applyUpdate(scratch, fromBase64(message.delta));
      const actual = await rootDigest(readState(scratch));
      if (actual !== claimed) {
        this.options.onError?.({
          code: "verification-failed",
          message: `bootstrap digest mismatch: claimed ${claimed}, projected ${actual}`,
        });
        return; // discard: never applied to the real document
      }
    }
    Y.applyUpdate(this.options.doc, fromBase64(message.delta), REMOTE_ORIGIN);
    // SW-3: when the envelope log ships with the bootstrap, replay it on a
    // scratch document — every transaction verified back to the first.
    if (message.envelopes && message.envelopes.length > 0) {
      const scratch = new Y.Doc();
      registerHeader(scratch, documentHeader(this.options.doc)); // side-channel parity for the comparison
      for (const item of message.envelopes) {
        const admission = await admitEnvelope(scratch, item.envelope, fromBase64(item.update));
        if (admission.verdict !== "allow") {
          this.options.onError?.({ code: "envelope-log-invalid", message: `bootstrap envelope log: ${admission.reason}` });
          return;
        }
      }
      const { canonicalJson } = await import("@nooq/core");
      const { readState: project } = await import("@nooq/yjs");
      if (canonicalJson(project(scratch)) !== canonicalJson(project(this.options.doc))) {
        this.options.onError?.({ code: "envelope-log-mismatch", message: "bootstrap delta disagrees with its envelope log" });
        return;
      }
    }
    this.markSynced();
  }

  private markSynced(): void {
    if (this.syncedFlag) return;
    this.syncedFlag = true;
    this.options.onSynced?.();
  }
}
