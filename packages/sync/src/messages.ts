/**
 * Wire envelope — SYNC.md SW-2. Messages are single UTF-8 JSON objects;
 * unknown `v` or `t` decode to null and MUST be ignored (forward
 * compatibility).
 */

export const WIRE_VERSION = 1;

/** An envelope as it travels the wire (DM-12): JSON through and through. */
export type WireEnvelope = import("@nooq/core").Envelope;
/** A checkpoint as it travels in a hello-reply (DM-15, SW-5). */
export interface WireCheckpoint {
  checkpoint: import("@nooq/core").Checkpoint;
  /** base64 canonical encoding of the attested state. */
  state: string;
  accessProof: WireEnvelope;
}
/** The only backend registered in wire v1 (SW-3). */
export const BACKEND = "yjs/1";

/** A presence cursor: block identity + offset, never a position (SW-7, DM-4). */
export interface CursorAnchor {
  block: string;
  offset: number;
  /** The selection's fixed end when it is not collapsed; `block`/`offset` is the caret, so receivers that ignore this still place it. */
  anchor?: { block: string; offset: number };
}

export type Cursor = CursorAnchor | null;

export type WireMessage =
  | { v: typeof WIRE_VERSION; t: "hello"; doc: string; backend: string; sv: string | null; update?: string | null; envelope?: WireEnvelope }
  | {
      v: typeof WIRE_VERSION;
      t: "hello-reply";
      doc: string;
      backend: string;
      sv: string;
      delta: string | null;
      rootDigest: string | null;
      /** DM-12/SW-3: the envelope log for access-controlled documents — after the checkpoint, when one ships. */
      envelopes?: Array<{ envelope: WireEnvelope; update: string }>;
      /** DM-15/SW-5: the latest checkpoint, the state it attests, and the owner-signed access write that proves its signer. */
      checkpoint?: WireCheckpoint;
    }
  | { v: typeof WIRE_VERSION; t: "update"; doc: string; update: string; envelope?: WireEnvelope }
  | { v: typeof WIRE_VERSION; t: "delta"; doc: string; sv?: string | null; delta?: string; rootDigest?: string }
  | {
      v: typeof WIRE_VERSION;
      t: "awareness";
      doc: string;
      actor: string;
      name?: string | null;
      cursor: Cursor;
    }
  | { v: typeof WIRE_VERSION; t: "error"; doc: string; code: string; message?: string };

export function encodeMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

/** Decode one frame; null for unknown version/type or malformed JSON (ignore per SW-2). */
export function decodeMessage(raw: string): WireMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as { v?: unknown; t?: unknown; doc?: unknown };
  if (message.v !== WIRE_VERSION) return null;
  if (typeof message.doc !== "string") return null;
  switch (message.t) {
    case "hello":
    case "hello-reply":
    case "update":
    case "delta":
    case "awareness":
    case "error":
      return parsed as WireMessage;
    default:
      return null;
  }
}

export function errorFor(doc: string, code: string, message?: string): WireMessage {
  return { v: WIRE_VERSION, t: "error", doc, code, ...(message ? { message } : {}) };
}
