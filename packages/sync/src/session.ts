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
import { readState } from "@nooq/yjs";
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
}

export class SyncSession {
  private readonly options: SyncSessionOptions;
  private syncedFlag = false;
  private closed = false;
  private readonly handleTransportMessage: (raw: string) => void;
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(options: SyncSessionOptions) {
    this.options = options;
    this.handleTransportMessage = (raw) => this.receive(raw);
    this.handleDocUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN || this.closed) return;
      this.options.transport.send(
        encodeMessage({ v: WIRE_VERSION, t: "update", doc: this.docId, update: toBase64(update) }),
      );
    };
    options.transport.onMessage(this.handleTransportMessage);
    options.doc.on("update", this.handleDocUpdate);
  }

  private get docId(): string {
    return (this.options.doc.getMap("header").get("docId") as string | undefined) ?? "";
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
        Y.applyUpdate(this.options.doc, fromBase64(message.update), REMOTE_ORIGIN);
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
    this.markSynced();
  }

  private markSynced(): void {
    if (this.syncedFlag) return;
    this.syncedFlag = true;
    this.options.onSynced?.();
  }
}
