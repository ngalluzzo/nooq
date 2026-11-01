/**
 * Type model — DM-3 (state), DM-4 (operations/transactions),
 * DM-5 (provenance), DM-6 (proposals).
 */

export type BlockId = string;
export type ActorId = string;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActorKind = "human" | "ai" | "importer" | "migration" | "system";

export interface ActorDescriptor {
  actorId: ActorId;
  kind: ActorKind;
  /** Model identifier when kind === "ai" (DM-5). */
  model?: string;
  /** Owning plugin when the actor acts on its behalf. */
  plugin?: string;
}

/**
 * Rendered inline content — the deterministic projection of the sequence
 * CRDT that digests are computed over (DM-6.1). `marks[i]` is the sorted,
 * unique set of mark names applied to `s[i]`; indices are UTF-16 code
 * units. Marks attach to characters, never to ranges (DM-3.3).
 */
export interface RenderedText {
  s: string;
  marks: string[][];
}

/**
 * Attribution stored in document state (DM-5). Deliberately excluded from
 * digests. Text authorship is per character, by client (DM-14.2), and is
 * read from the adapter's client registry, never rewritten per edit.
 */
export interface Attribution {
  created: { actor: ActorId };
  /** Each field's last writer; `adoptedBy` when an adoption wrote it (DM-6.3). */
  fields: Record<string, { actor: ActorId; lamport: number; adoptedBy?: ActorId }>;
}

export interface Block {
  id: BlockId;
  /** Block type with version, e.g. "nooq.paragraph/v1". */
  type: string;
  /** LWW registers, one per key (DM-3.2). Values replaced wholesale. */
  fields: Record<string, JsonValue>;
  text?: RenderedText;
  /** Ordered child block IDs (DM-3). Tombstoned children are absent here. */
  children: BlockId[];
  attribution: Attribution;
}

/** DM-13. A checkpointer signs checkpoints (DM-15) and nothing else. */
export type Role = "writer" | "suggester" | "reader" | "checkpointer";

export interface Grant {
  actorId: ActorId;
  /** base64 raw Ed25519 public key bound to the actor (DM-13). */
  key: string;
  /** The kind this actor's transactions must claim (DM-13, Draft 1.7). */
  kind: ActorKind;
  role: Role;
}

export interface Access {
  owner: { actorId: ActorId; key: string; kind: ActorKind };
  /** Append-only in v1 (DM-13); revocation is a fork (DM-10.6). */
  grants: Grant[];
  /** With `owner`, fingerprints into a secured document's ID (DM-13). */
  nonce: string;
  /** DM-16: the lineage this one was rebased from. Set at genesis, never changed. */
  rebasedFrom?: { docId: string; checkpoint: string | null };
}

export interface DocState {
  docId: string;
  schemaVersion: number;
  /** Present only in access-controlled documents (DM-13). */
  access?: Access;
  /** Live root block IDs in order. */
  roots: BlockId[];
  blocks: Record<BlockId, Block>;
}

export type Op =
  | { op: "insert"; block: Block; parent: BlockId | null; index?: number }
  | { op: "setField"; block: BlockId; key: string; value: JsonValue }
  /** DM-4.3 (Draft 1.5): splice steps applied left to right. */
  | { op: "textEdit"; block: BlockId; changes: readonly import("./text.ts").TextChange[] }
  | { op: "move"; block: BlockId; newParent: BlockId | null; index?: number }
  | { op: "delete"; block: BlockId }
  | { op: "restore"; block: BlockId; parent: BlockId | null; index?: number }
  /** DM-13: write the document's access header. Owner-signed envelopes only. */
  | { op: "setAccess"; access: Access };

export interface Transaction {
  id: string;
  actor: ActorDescriptor;
  /**
   * Present only on suggestion-adoption transactions (DM-6.3): names the
   * actor who accepted the proposal. The transaction's own actor is the
   * proposer, so block-level attribution keeps pointing at the proposer.
   */
  adoptedBy?: ActorId;
  lamport: number;
  /** Version vector of transactions this one saw (DM-2). */
  causality: Record<ActorId, number>;
  intent?: string;
  ops: Op[];
}

/** Evidence pins content and structure separately so revalidation can distinguish drift kinds (DM-6.1, Draft 1.1). */
export interface ProposalEvidenceEntry {
  block: BlockId;
  contentDigest: string;
  structureDigest: string;
}

/** The payload of a nooq.suggestion/v1 block (DM-6). */
export interface Proposal {
  base: { rootDigest: string };
  ops: Op[];
  evidence: ProposalEvidenceEntry[];
  context: JsonValue;
  /** What the proposal is for (DM-4 intent), shown when it is reviewed. */
  intent?: string;
  actor: ActorId;
  /** The proposer's full descriptor (DM-5) — accept authors as the proposer (DM-6.3). */
  actorDescriptor?: ActorDescriptor;
}
