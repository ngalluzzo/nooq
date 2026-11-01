/** Logical authoring checks. Remote admission must still inspect physical updates. */
import { authorize, isSecuredDocId, type Touched, type Verdict } from "./access.ts";
import { canonicalJson } from "./canonical.ts";
import { tryValidateReadonly, validateTransaction } from "./engine.ts";
import type { ActorDescriptor, DocState, Proposal, Transaction } from "./model.ts";


import { registrationOf } from "./registry.ts";
import { liveTree } from "./tree.ts";

export interface LocalPrincipal {
  actorId: string;
  /** Host-verified signing capability's public key, never supplied by a command. */
  key?: string;
  signingReady: boolean;
}
export interface LocalVerdict { verdict: Verdict; reason: string }

/** Payload/identity equality is shared with remote admission; liveness is local. */
export function adoptionMatchesState(state: DocState, tx: Transaction): boolean | undefined {
  if (!tx.adoptedBy) return true;
  const status = tx.ops.at(-2), deletion = tx.ops.at(-1);
  if (!status || status.op !== "setField" || status.key !== "status" || status.value !== "accepted"
    || deletion?.op !== "delete" || status.block !== deletion.block) return false;
  const block = state.blocks[status.block];
  if (!block) return undefined;
  if (block.type !== "nooq.suggestion/v1") return false;
  const proposal = block.fields.proposal as unknown as Proposal;
  if (!proposal?.ops || proposal.actor !== tx.actor.actorId) return false;
  const descriptor: ActorDescriptor = proposal.actorDescriptor ?? { actorId: proposal.actor, kind: "ai",
    ...((proposal.context as { model?: string } | null)?.model ? { model: (proposal.context as { model: string }).model } : {}),
  };
  try {
    return canonicalJson(tx.ops.slice(0, -2)) === canonicalJson(proposal.ops)
      && canonicalJson(tx.actor) === canonicalJson(descriptor);
  } catch { return false; }
}

export function authorizeLocal(state: DocState, tx: Transaction, principal: LocalPrincipal, fresh?: () => DocState): LocalVerdict {
  const deny = (reason: string): LocalVerdict => ({ verdict: "deny", reason });
  if ((tx.adoptedBy ?? tx.actor.actorId) !== principal.actorId) return deny("signer-author-mismatch");
  // Core validation observes earlier operations in the same batch, without
  // mutating the caller's state. EB-6: the read-only fast path covers the
  // dominant shapes against the SHARED projection for free; structural
  // shapes pay one fresh in-place validation. (The old pure applyTransaction
  // cloned the whole state — ~26ms per keystroke at 2,000 blocks.)
  try {
    canonicalJson(tx);
    if (!tryValidateReadonly(state, tx)) validateTransaction(fresh ? fresh() : structuredClone(state), tx);
  } catch { return deny("invalid-transaction"); }
  if (tx.adoptedBy) {
    if (adoptionMatchesState(state, tx) !== true) return deny("invalid-adoption");
    const settlement = tx.ops.at(-1)!;
    if (settlement.op !== "delete" || !liveTree(state).alive.has(settlement.block)
      || state.blocks[settlement.block]!.fields.status !== undefined) return deny("already-settled");
  }
  if (!isSecuredDocId(state.docId)) {
    if (state.access || tx.ops.some(op => op.op === "setAccess")) return deny("open-document-access-write");
    return { verdict: "allow", reason: "open-document" };
  }
  if (!state.access) return { verdict: "hold", reason: "awaiting-genesis" };
  if (!principal.signingReady || !principal.key) return { verdict: "hold", reason: "signer-not-ready" };
  const touched: Touched = { inserts: [], structuralOps: false, otherContentOps: false, accessWrites: false,
    deletedBlocks: [], unresolved: false, bookkeepingWrites: false, registration: registrationOf(tx), accessValues: [] };
  const types = new Map(Object.values(state.blocks).map(b => [b.id, b.type]));
  for (const op of tx.ops) {
    if (op.op === "insert") {
      types.set(op.block.id, op.block.type);
      touched.inserts.push(op.block.type);
      // Attaching old children is not suggestion-only creation.
      if (op.block.children.length) touched.otherContentOps = true;
    } else if (op.op === "setAccess") {
      touched.accessWrites = true; touched.accessValues.push(op.access);
    } else {
      touched.otherContentOps = true;
      if (op.op === "delete") touched.deletedBlocks.push(op.block);
      if (["move", "delete", "restore"].includes(op.op) && types.get(op.block) !== "nooq.suggestion/v1") touched.structuralOps = true;
    }
  }
  const verdict = authorize(state.access, { tx, signer: principal.actorId, signerKey: principal.key }, touched);
  return { verdict, reason: verdict === "allow" ? "authorized" : verdict === "hold" ? "grant-not-ready" : "permission-denied" };
}
