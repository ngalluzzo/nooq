import { applyTransaction, computeDigests, liveTree, rootDigest, subtreeOf } from "@nooq/core";
import type { ActorDescriptor, Block, DocState, JsonValue, Op, Proposal } from "@nooq/core";
import { freezeSnapshot, type Immutable } from "./definitions.ts";

export type PublicationResult = { status: "published"; suggestion: string }
  | { status: "unsupported-evidence"; reason: string }
  | { status: "denied"; reason: string; retryable: boolean }
  | { status: "cancelled" };
export interface JobContext {
  signal: AbortSignal;
  capture(): ProposalCapture;
  publish(base: ProposalCapture, input: { ops: readonly Op[]; context?: JsonValue; intent?: string }): Promise<PublicationResult>;
  progress(value: JsonValue): void;
  createBlock(type: string): Block;
}
export interface Job<Args, Result> {
  id: string;
  label: string;
  /** Publishing jobs need an explicit host actor/signer binding. */
  publishes?: boolean;
  validateArgs(input: unknown): input is Args;
  run(context: JobContext, args: Args): Promise<Result>;
}
export interface JobHandle<Result> {
  result: Promise<Result>;
  signal: AbortSignal;
  cancel(): void;
  onProgress(listener: (value: Immutable<JsonValue>) => void): () => void;
}
export function defineJob<Args, Result>(job: Job<Args, Result>): Readonly<Job<Args, Result>> {
  if (!job.id || !job.label || typeof job.validateArgs !== "function" || typeof job.run !== "function") throw new Error("Invalid job definition");
  return Object.freeze({ ...job });
}
export class UnsupportedEvidenceError extends Error {
  constructor(message: string) { super(message); this.name = "UnsupportedEvidenceError"; }
}
export type CapturedBlock = Immutable<Pick<Block, "id" | "type" | "fields" | "text" | "children">>;

/** A detached base. No roots, header, log, attribution, or live document is exposed. */
export class ProposalCapture {
  readonly #base: DocState;
  readonly #reads = new Set<string>();
  constructor(state: DocState) { this.#base = structuredClone(state); }
  readBlocks(ids: readonly string[]): readonly CapturedBlock[] {
    const alive = liveTree(this.#base).alive;
    return ids.map(id => {
      if (!alive.has(id)) throw new UnsupportedEvidenceError(`Cannot cover absent or tombstoned block ${id}`);
      this.#reads.add(id);
      const { type, fields, text, children } = this.#base.blocks[id]!;
      return freezeSnapshot({ id, type, fields, ...(text ? { text } : {}), children });
    });
  }
  readSubtrees(ids: readonly string[]): readonly CapturedBlock[] {
    this.readBlocks(ids);
    return this.readBlocks([...new Set(ids.flatMap(id => [...subtreeOf(this.#base, id)]))].sort());
  }
  async proposal(operations: readonly Op[], actor: ActorDescriptor, context: JsonValue = {}): Promise<Proposal> {
    const ops = structuredClone([...operations]);
    const evidence = new Set(this.#reads), alive = liveTree(this.#base).alive;
    let working = this.#base;
    const cover = (id: string | null) => {
      if (id === null) throw new UnsupportedEvidenceError("Root membership/order is not representable by current evidence");
      if (!this.#base.blocks[id]) return; // an insertion earlier in this batch has no base digest
      if (!alive.has(id)) throw new UnsupportedEvidenceError(`Tombstone dependency ${id}`);
      evidence.add(id);
    };
    for (const op of ops) {
      if (op.op === "restore" || op.op === "setAccess") throw new UnsupportedEvidenceError(`${op.op} dependencies are not representable`);
      if (op.op === "insert") {
        if (op.block.children.length) throw new UnsupportedEvidenceError("Insert children through separate operations");
        if (this.#base.blocks[op.block.id]) throw new Error("Inserted IDs must be fresh");
        if (op.block.attribution.created.actor !== actor.actorId || Object.keys(op.block.attribution.fields).length || op.block.attribution.text) throw new Error("Inserted block must belong to the bound actor with fresh attribution");
        cover(op.parent);
      } else {
        cover(op.block);
        if (op.op === "move" || op.op === "delete") {
          for (const id of subtreeOf(working, op.block)) cover(id);
          const parent = liveTree(working).parentOf.get(op.block);
          if (parent === undefined) throw new UnsupportedEvidenceError(`Non-live structural target ${op.block}`);
          cover(parent);
          if (op.op === "move") cover(op.newParent);
        }
      }
      working = applyTransaction(working, { id: "validate-capture", actor, lamport: 0, causality: {}, ops: [op] });
    }
    const digests = await computeDigests(this.#base);
    const before: Record<string, string> = {};
    for (const op of ops) if (op.op === "textEdit" && this.#base.blocks[op.block]) before[op.block] = this.#base.blocks[op.block]!.text?.s ?? "";
    return {
      base: { rootDigest: await rootDigest(this.#base) }, ops,
      evidence: [...evidence].sort().map(block => {
        const digest = digests.get(block);
        if (!digest) throw new UnsupportedEvidenceError(`No live digest for ${block}`);
        return { block, contentDigest: digest.contentDigest, structureDigest: digest.structureDigest };
      }),
      actor: actor.actorId, actorDescriptor: structuredClone(actor),
      context: { ...(context && !Array.isArray(context) && typeof context === "object" ? context : { data: context }), before },
    };
  }
}
