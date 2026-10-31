/**
 * Suggestion lifecycle — DM-6.3/6.4.
 *
 * A suggestion is an ordinary block (nooq.suggestion/v1) whose fields
 * carry a content-addressed proposal. Accept and reject are ordinary
 * transactions, so they replicate, converge, and audit like everything
 * else. The verdict (accepted/rejected) is written to the suggestion
 * block's fields before tombstoning it, making it derivable from state.
 */

import { evaluate, type Evaluation } from "./evaluate.ts";
import type {
  ActorDescriptor,
  ActorId,
  Block,
  BlockId,
  DocState,
  JsonValue,
  Op,
  Proposal,
  Transaction,
} from "./model.ts";

export const SUGGESTION_TYPE = "nooq.suggestion/v1";
export const STATUS_KEY = "status";

/** Thrown by acceptTransaction when the proposal is not fresh and force is not set. */
export class StaleSuggestionError extends Error {
  readonly evaluation: Evaluation;
  constructor(evaluation: Evaluation) {
    super(`suggestion is ${evaluation.status}, not fresh (force to accept anyway)`);
    this.name = "StaleSuggestionError";
    this.evaluation = evaluation;
  }
}

/** A nooq.suggestion/v1 block carrying the proposal (DM-6). */
export function makeSuggestionBlock(
  proposal: Proposal,
  proposer: ActorId,
  id?: BlockId,
): Block {
  return {
    id: id ?? crypto.randomUUID(),
    type: SUGGESTION_TYPE,
    fields: { proposal: structuredClone(proposal) as unknown as JsonValue },
    children: [],
    attribution: { created: { actor: proposer }, fields: {} },
  };
}

/** Extract and revalidate the proposal carried by a suggestion block (DM-6.2). */
export async function evaluateSuggestion(
  state: DocState,
  suggestion: BlockId,
): Promise<Evaluation> {
  const block = state.blocks[suggestion];
  if (!block) throw new Error(`no such block ${suggestion}`);
  if (block.type !== SUGGESTION_TYPE) throw new Error(`block ${suggestion} is not a suggestion`);
  return evaluate(block.fields.proposal as unknown as Proposal, state);
}

export interface AcceptOptions {
  state: DocState;
  suggestion: BlockId;
  /** The accepting actor — recorded as adoptedBy; the proposer authors the transaction. */
  actor: ActorDescriptor;
  lamport: number;
  /** Apply despite stale/conflicted evidence (the writer decides, DM-6.3). May still fail loudly. */
  force?: boolean;
  causality?: Record<ActorId, number>;
}

/**
 * Build the acceptance transaction (DM-6.3): the proposal's ops verbatim,
 * authored by the proposer, with adoptedBy naming the accepter, followed by
 * status + tombstone of the suggestion block in the same transaction.
 */
export function acceptTransaction(options: AcceptOptions): Transaction {
  const block = options.state.blocks[options.suggestion];
  if (!block) throw new Error(`no such block ${options.suggestion}`);
  if (block.type !== SUGGESTION_TYPE) throw new Error(`block ${options.suggestion} is not a suggestion`);
  const proposal = block.fields.proposal as unknown as Proposal;

  const ops: Op[] = [
    ...structuredClone(proposal.ops),
    { op: "setField", block: options.suggestion, key: STATUS_KEY, value: "accepted" },
    { op: "delete", block: options.suggestion },
  ];
  const model = (proposal.context as { model?: string } | null)?.model;
  return {
    id: crypto.randomUUID(),
    actor: { actorId: proposal.actor, kind: "ai", ...(model ? { model } : {}) },
    adoptedBy: options.actor.actorId,
    lamport: options.lamport,
    causality: structuredClone(options.causality ?? {}),
    intent: `accept-suggestion:${options.suggestion}`,
    ops,
  };
}

/**
 * Checked acceptance: evaluates first, throws StaleSuggestionError when not
 * fresh (unless force), then builds the adoption transaction.
 */
export async function acceptChecked(options: AcceptOptions): Promise<Transaction> {
  const evaluation = await evaluateSuggestion(options.state, options.suggestion);
  if (!options.force && evaluation.status !== "fresh") throw new StaleSuggestionError(evaluation);
  const transaction = acceptTransaction(options);
  return evaluation.status === "fresh"
    ? transaction
    : { ...transaction, intent: `${transaction.intent}:${evaluation.status}` };
}

/** Build the rejection transaction (DM-6.4): status + tombstone, payload persists. */
export function rejectTransaction(options: {
  suggestion: BlockId;
  actor: ActorDescriptor;
  lamport: number;
  causality?: Record<ActorId, number>;
}): Transaction {
  return {
    id: crypto.randomUUID(),
    actor: options.actor,
    lamport: options.lamport,
    causality: structuredClone(options.causality ?? {}),
    intent: `reject-suggestion:${options.suggestion}`,
    ops: [
      { op: "setField", block: options.suggestion, key: STATUS_KEY, value: "rejected" },
      { op: "delete", block: options.suggestion },
    ],
  };
}
