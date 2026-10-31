/**
 * Block digests — DM-6.1 (Draft 1.2).
 *
 * Three digests per block:
 * - contentDigest: {type, fields, textDigest} — what the block says.
 * - structureDigest: {children: [{id, structureDigest}]} — the content-free
 *   recursive shape. Descendant content drift never changes an ancestor's
 *   structureDigest; this is what separates `stale` from `conflicted`.
 * - blockDigest: {contentDigest, structureDigest, children: [child blockDigests]}
 *   — the full Merkle digest; any change anywhere below changes it.
 *
 * A children entry whose block is absent from the map serializes as null
 * (malformed/GC'd documents) so revalidation degrades instead of crashing.
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
  for (const id of Object.keys(state.blocks)) await digestsOf(state, id, memo, []);
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
  if (ancestors.includes(id)) throw new Error(`Cycle at ${id} (DM-3.1 violation)`);

  const block = state.blocks[id];
  if (!block) throw new Error(`Missing block ${id}`);

  const stack = [...ancestors, id];
  const textDigest = block.text
    ? await fingerprint({ s: block.text.s, marks: block.text.marks })
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
