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

/** Attribution stored in document state (DM-5). Deliberately excluded from digests. */
export interface Attribution {
  created: { actor: ActorId };
  fields: Record<string, { actor: ActorId; lamport: number }>;
  text?: { actor: ActorId; lamport: number };
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

export interface DocState {
  docId: string;
  schemaVersion: number;
  /** Live root block IDs in order. */
  roots: BlockId[];
  blocks: Record<BlockId, Block>;
  /** Append-only durable intent log (DM-4). */
  log: Transaction[];
}

export type Op =
  | { op: "insert"; block: Block; parent: BlockId | null; index?: number }
  | { op: "setField"; block: BlockId; key: string; value: JsonValue }
  /**
   * v0 simplification: full rendered-content replacement. DM-4.3 sequence
   * CRDT ops arrive with the Yjs adapter; the state shape they produce is
   * identical, so digests are unaffected.
   */
  | { op: "textEdit"; block: BlockId; replace: RenderedText }
  | { op: "move"; block: BlockId; newParent: BlockId | null; index?: number }
  | { op: "delete"; block: BlockId }
  | { op: "restore"; block: BlockId; parent: BlockId | null; index?: number };

export interface Transaction {
  id: string;
  actor: ActorDescriptor;
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
  actor: ActorId;
}
