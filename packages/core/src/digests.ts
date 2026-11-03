/**
 * Block digests — DM-6.1 (Draft 1.3).
 *
 * Digests are defined over the ALIVE FOREST: blocks reachable from roots.
 * The forest is single-parent by construction, so each alive block has a
 * unique path from a root — digests are context-free and memoizable, and
 * placement cycles orphaned by concurrent merges (unreachable) never
 * enter the walk. Unreachable blocks have no digest entries; evaluate
 * reports them as tombstoned/missing before comparing digests.
 *
 * - contentDigest: {type, fields, textDigest} — what the block says.
 * - structureDigest: {children: [{id, structureDigest}]} — the content-free
 *   recursive shape. Descendant content drift never changes an ancestor's
 *   structureDigest; this is what separates `stale` from `conflicted`.
 * - blockDigest: {contentDigest, structureDigest, children: [child blockDigests]}
 *   — the full Merkle digest; any change anywhere below changes it.
 *
 * Deliberate: attribution is excluded from every digest input. Provenance
 * is metadata about change, not content; an attribution update must never
 * stale a suggestion.
 */

import { fingerprint } from "./digest.ts";
import type { BlockId, DocState } from "./model.ts";

export interface BlockDigests {
  /** Fingerprint over {contentDigest, structureDigest, children: [child blockDigests]}. */
  blockDigest: string;
  /** Fingerprint over {type, fields, textDigest}. */
  contentDigest: string;
  /** Fingerprint over {s, marks}, or null when the block has no inline content. */
  textDigest: string | null;
  /** Fingerprint over {children: [{id, structureDigest}]} — content-free shape. */
  structureDigest: string;
}

export async function computeDigests(state: DocState): Promise<Map<BlockId, BlockDigests>> {
  const memo = new Map<BlockId, BlockDigests>();
  for (const root of state.roots) await digestsOf(state, root, memo, []);
  return memo;
}

async function digestsOf(
  state: DocState,
  id: BlockId,
  memo: Map<BlockId, BlockDigests>,
  ancestors: readonly BlockId[],
): Promise<BlockDigests> {
  const hit = memo.get(id);
  if (hit) return hit;
  if (ancestors.includes(id)) throw new Error(`Cycle at ${id} within the alive forest (DM-3.1 violation)`);

  const block = state.blocks[id];
  if (!block) throw new Error(`Missing block ${id}`);

  const stack = [...ancestors, id];
  // 0013 (DM-10.2): the canonical text form is RUNS — minimal, ordered,
  // non-overlapping; adjacent equal-marks runs merge, empty-marks runs are
  // omitted — content-equal marks derive byte-equal runs, so the digest is
  // stable across equivalent per-character representations, and 10k
  // formatted characters digest ~150 bytes instead of ~93,000 (measured,
  // packages/core/test/mark-churn.test.ts). Identity re-derived once, here.
  const textDigest = block.text
    ? await fingerprint({ s: block.text.s, runs: runsOf(block.text) })
    : null;
  const childDigests: Array<string | null> = [];
  const childStructure: Array<{ id: BlockId; structureDigest: string | null }> = [];
  for (const child of block.children) {
    const childInfo = state.blocks[child]
      ? await digestsOf(state, child, memo, stack)
      : null;
    childDigests.push(childInfo ? childInfo.blockDigest : null);
    childStructure.push({ id: child, structureDigest: childInfo ? childInfo.structureDigest : null });
  }

  const contentDigest = await fingerprint({ type: block.type, fields: block.fields, textDigest });
  const structureDigest = await fingerprint({ children: childStructure });
  const blockDigest = await fingerprint({ contentDigest, structureDigest, children: childDigests });

  const info: BlockDigests = { blockDigest, contentDigest, textDigest, structureDigest };
  memo.set(id, info);
  return info;
}

/** Fingerprint over the ordered live roots' block digests (DM-6.1). */
export async function rootDigest(state: DocState): Promise<string> {
  const memo = await computeDigests(state);
  const roots: string[] = [];
  for (const id of state.roots) {
    const info = memo.get(id);
    if (!info) throw new Error(`Missing root ${id}`);
    roots.push(info.blockDigest);
  }
  return fingerprint({ roots });
}


/** A canonical text run: one marks set over [from, to). (0013) */
export interface TextRun { marks: readonly string[]; from: number; to: number }

/**
 * Per-character marks → minimal runs (0013, the canonical form): ordered,
 * non-overlapping; adjacent runs with equal marks merge; a run whose marks
 * are empty is omitted entirely — unmarked text is the absence of a run.
 * Deterministic: content-equal inputs derive byte-equal runs.
 */
export function runsOf(text: { s: string; marks: readonly (readonly string[])[] }): TextRun[] {
  const runs: TextRun[] = [];
  let current: { marks: string[]; from: number } | undefined;
  const keyOf = (marks: readonly string[]): string => [...new Set(marks)].filter(Boolean).sort().join("\u0000");
  for (let at = 0; at < text.s.length; at++) {
    const marks = [...new Set(text.marks[at] ?? [])].filter(Boolean).sort();
    const key = keyOf(marks);
    if (current !== undefined && keyOf(current.marks) === key) continue; // extend: same set
    if (current !== undefined && current.marks.length > 0) runs.push({ marks: current.marks, from: current.from, to: at });
    current = marks.length > 0 ? { marks, from: at } : undefined;
  }
  if (current !== undefined && current.marks.length > 0) runs.push({ marks: current.marks, from: current.from, to: text.s.length });
  return runs;
}
