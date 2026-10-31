/**
 * Suggestion revalidation — DM-6.2/6.5.
 *
 * evaluate() is a pure function of (proposal, state): every peer that has
 * merged the same operations computes the identical status with zero
 * communication. Status is derived, never stored. Drift is life (see
 * DM-6.5): the proposal degrades visibly instead of aborting.
 *
 * Precedence (deterministic): conflicted > stale > fresh. A block is only
 * reported with its most severe reason, and drift entries are sorted by
 * block ID.
 */

import { computeDigests } from "./digests.ts";
import type { BlockId, DocState, Proposal } from "./model.ts";
import { liveTree } from "./tree.ts";

export type SuggestionStatus = "fresh" | "stale" | "conflicted";

export type DriftReason = "missing" | "tombstoned" | "structure" | "content";

export interface DriftEntry {
  block: BlockId;
  reason: DriftReason;
}

export interface Evaluation {
  status: SuggestionStatus;
  drift: DriftEntry[];
}

export async function evaluate(proposal: Proposal, state: DocState): Promise<Evaluation> {
  const digests = await computeDigests(state);
  const { alive } = liveTree(state, { onMissing: "skip" });
  const drift: DriftEntry[] = [];

  const entries = [...proposal.evidence].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  for (const entry of entries) {
    if (!state.blocks[entry.block]) {
      drift.push({ block: entry.block, reason: "missing" });
      continue;
    }
    if (!alive.has(entry.block)) {
      drift.push({ block: entry.block, reason: "tombstoned" });
      continue;
    }
    const current = digests.get(entry.block);
    if (!current) {
      // Alive blocks always have digests (DM-6.1); treat the impossible
      // defensively as structural drift rather than crashing.
      drift.push({ block: entry.block, reason: "structure" });
      continue;
    }
    if (current.structureDigest !== entry.structureDigest) {
      drift.push({ block: entry.block, reason: "structure" });
      continue;
    }
    if (current.contentDigest !== entry.contentDigest) {
      drift.push({ block: entry.block, reason: "content" });
    }
  }

  const conflicted = drift.some(
    (entry) => entry.reason === "missing" || entry.reason === "tombstoned" || entry.reason === "structure",
  );
  const status: SuggestionStatus = conflicted ? "conflicted" : drift.length > 0 ? "stale" : "fresh";
  return { status, drift };
}
