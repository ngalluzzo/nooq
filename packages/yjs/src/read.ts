/**
 * Projection — Y.Doc → DocState (pure; no mutation).
 *
 * The placement register is the authority: a block's container is its
 * register entry (or nothing, when tombstoned). Physical array entries
 * that disagree with the register are ignored as strays; entries missing
 * from their authoritative container are healed (appended, sorted by block
 * ID for determinism). Liveness is reachability from roots, so placement
 * cycles formed by concurrent moves converge to tombstones (data intact)
 * identically on every peer. The projected state satisfies DM-3.1 by
 * construction, so every core function (digests, evaluate, liveTree)
 * works unchanged.
 */

import type * as Y from "yjs";
import type {
  ActorId,
  Attribution,
  Block,
  BlockId,
  DocState,
  JsonValue,
  RenderedText,
} from "@nooq/core";
import { REGISTER, documentHeader, layout, type Register } from "./layout.ts";

function isRegister(raw: unknown): raw is Register {
  return typeof raw === "object" && raw !== null && (raw as { nooq?: unknown }).nooq === REGISTER;
}

export function readState(doc: Y.Doc): DocState {
  const header = documentHeader(doc);
  const { blocks: yblocks, roots: yroots, placement, access: yaccess } = layout(doc);

  const containerOf = new Map<BlockId, BlockId | null>();
  for (const id of yblocks.keys()) {
    const entry = placement.get(id);
    if (entry && !entry.tombstoned) containerOf.set(id, entry.parent);
  }

  const childrenOf = (container: BlockId | null): BlockId[] => {
    const physical =
      container === null
        ? yroots.toArray()
        : ((yblocks.get(container)?.get("children") as Y.Array<BlockId> | undefined)?.toArray() ?? []);
    const out: BlockId[] = [];
    const seen = new Set<BlockId>();
    for (const id of physical) {
      if (containerOf.get(id) !== container) continue; // stray or tombstoned
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    const missing: BlockId[] = [];
    for (const [id, container2] of containerOf) {
      if (container2 === container && !seen.has(id)) missing.push(id);
    }
    missing.sort();
    out.push(...missing);
    return out;
  };

  const blocks: Record<BlockId, Block> = {};
  for (const [id, yb] of yblocks.entries()) {
    blocks[id] = readBlock(id, yb, childrenOf);
  }

  const accessEntry = yaccess.get("access");
  const accessJson = accessEntry === undefined ? undefined : (structuredClone(accessEntry) as unknown);
  return {
    docId: header.docId,
    schemaVersion: header.schemaVersion,
    ...(accessJson ? { access: accessJson as DocState["access"] } : {}),
    roots: childrenOf(null),
    blocks,
  };
}

/** @internal reused by the maintained projection */
export function readBlock(id: BlockId, yb: Y.Map<unknown>, childrenOf: (container: BlockId | null) => BlockId[]): Block {
  const fields: Record<string, JsonValue> = {};
  const attribution: Attribution = {
    created: { actor: (yb.get("createdBy") as ActorId | undefined) ?? "" },
    fields: {},
  };
  const yfields = yb.get("fields") as Y.Map<unknown> | undefined;
  if (yfields) {
    for (const [key, raw] of yfields.entries()) {
      if (isRegister(raw)) {
        fields[key] = structuredClone(raw.value);
        attribution.fields[key] = { actor: raw.actor, lamport: raw.lamport, ...(raw.adoptedBy !== undefined ? { adoptedBy: raw.adoptedBy } : {}) };
      } else {
        fields[key] = structuredClone(raw) as JsonValue;
      }
    }
  }
  const yt = yb.get("text") as Y.Text | undefined;
  return {
    id,
    type: (yb.get("type") as string | undefined) ?? "unknown",
    fields,
    ...(yt ? { text: readText(yt) } : {}),
    children: childrenOf(id),
    attribution,
  };
}

/** Canonical rendered {s, marks} from a Y.Text delta (DM-3.3 per-character marks). */
function readText(yt: Y.Text): RenderedText {
  let s = "";
  const marks: string[][] = [];
  for (const run of yt.toDelta() as unknown as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    const str = typeof run.insert === "string" ? run.insert : "";
    const attrs = run.attributes ?? {};
    const names = Object.keys(attrs)
      .filter((name) => Boolean(attrs[name]))
      .sort();
    s += str;
    for (let i = 0; i < str.length; i++) marks.push([...names]);
  }
  return { s, marks };
}
