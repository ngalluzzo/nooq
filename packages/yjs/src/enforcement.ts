/**
 * Enforcement — DM-12/13 in the adapter.
 *
 * commitSigned: run a validated transaction with a known origin, capture
 * exactly its incremental update, and seal it in a signed envelope.
 *
 * inspectUpdate: pure classification of an update's structs into what
 * DM-13's authorize() needs (which blocks, what kinds of writes, whose
 * deletes). Deterministic for causally ready updates: parents resolve
 * within the update itself or against the local store.
 *
 * admitEnvelope: verify → authorize → apply, identically on every peer.
 * Invalid envelopes are never applied; ungranted signers hold.
 */

import * as Y from "yjs";
import {
  authorize,
  updateDigestOf,
  verifyEnvelope,
  type ActorKey,
  type Access,
  type Envelope,
  type Touched,
  type Verdict,
} from "@nooq/core";
import { applyTransaction, documentHeader } from "./index.ts";
import { layout } from "./layout.ts";
import { readState } from "./read.ts";

const COMMIT_ORIGIN = "nooq-commit";
const ADMIT_ORIGIN = "nooq-admit";

export interface Committed {
  envelope: Envelope;
  update: Uint8Array;
}

/** Run a nooq transaction and seal its exact effects (DM-12). */
export async function commitSigned(doc: Y.Doc, tx: import("@nooq/core").Transaction, key: ActorKey, signer: string): Promise<Committed> {
  const captured = applyCaptured(doc, tx, key, signer);
  const envelope = await sealEnvelope(doc, tx, captured.update, key, signer);
  return { envelope, update: captured.update };
}

/** The synchronous half: validate, apply atomically, capture the update. */
export function applyCaptured(
  doc: Y.Doc,
  tx: import("@nooq/core").Transaction,
  key: ActorKey,
  signer?: string,
): { tx: import("@nooq/core").Transaction; update: Uint8Array; key: ActorKey; signer: string } {
  void key;
  const captured: Uint8Array[] = [];
  const handler = (update: Uint8Array, origin: unknown) => {
    if (origin === COMMIT_ORIGIN) captured.push(update);
  };
  doc.on("update", handler);
  try {
    applyTransaction(doc, tx, COMMIT_ORIGIN);
  } finally {
    doc.off("update", handler);
  }
  if (captured.length !== 1) {
    throw new Error(`expected exactly one update for one transaction, got ${captured.length}`);
  }
  return { tx, update: captured[0]!, key, signer: signer ?? tx.actor.actorId };
}

/** The asynchronous half: seal the envelope over the captured update. */
export async function sealEnvelope(
  doc: Y.Doc,
  tx: import("@nooq/core").Transaction,
  update: Uint8Array,
  key: ActorKey,
  signer: string,
): Promise<Envelope> {
  const clocks = clocksOf(update, doc.clientID);
  return (await import("@nooq/core")).signEnvelope(
    { docId: documentHeader(doc).docId, tx, client: doc.clientID, clocks, updateDigest: await updateDigestOf(update) },
    key,
    signer,
  );
}

function clocksOf(update: Uint8Array, client: number): { from: number; to: number } {
  const decoded = Y.decodeUpdate(update) as unknown as { structs: Array<{ id: { client: number; clock: number } }> };
  const mine = decoded.structs.filter((struct) => struct.id.client === client);
  if (mine.length === 0) return { from: 0, to: -1 };
  return {
    from: Math.min(...mine.map((struct) => struct.id.clock)),
    to: Math.max(...mine.map((struct) => struct.id.clock)),
  };
}

interface StructItem {
  id: { client: number; clock: number };
  parent: unknown; // root name string | {client, clock} | null (later same-key items)
  /** Left origin: the previous item on this key/sequence, null for the first. */
  origin?: { client: number; clock: number } | null;
  /** Right origin: the next item, set for inserts with a right neighbor. */
  rightOrigin?: { client: number; clock: number } | null;
  parentSub: string | null;
  content?: { arr?: unknown[]; contentType?: unknown } & Record<string, unknown>;
  constructor: { name: string };
}

interface BlockTouch {
  type: string | null;
  insert: boolean;
  fieldsOrText: boolean;
  placement: boolean;
  deleted: boolean;
}

/**
 * Classify an update's effects. `updateBlocks` receives (blockId, type,
 * kind) for every touched block; kinds: "insert" | "content" | "placement"
 * | "delete". Returns {accessWrites, foreignClients}.
 */
export function inspectUpdate(
  doc: Y.Doc,
  update: Uint8Array,
): { touched: Touched; blockTouches: Map<string, BlockTouch>; foreignClients: Set<number>; clockRange: { from: number; to: number } } {
  const decoded = Y.decodeUpdate(update) as unknown as { structs: StructItem[]; ds: { clients?: Map<number, unknown[]> } };
  const structs = decoded.structs ?? [];
  const byId = new Map<string, StructItem>();
  for (const struct of structs) byId.set(idKey(struct.id), struct);

  const blockTouches = new Map<string, BlockTouch>();
  const accessWrites = { value: false };
  const foreignClients = new Set<number>();
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  const ensureTouch = (blockId: string): BlockTouch => {
    let touch = blockTouches.get(blockId);
    if (!touch) {
      touch = { type: null, insert: false, fieldsOrText: false, placement: false, deleted: false };
      blockTouches.set(blockId, touch);
    }
    return touch;
  };

  const blockTypeOf = (blockId: string, inUpdate: StructItem | undefined): string | null => {
    if (inUpdate) {
      for (const candidate of structs) {
        const candidateParent = candidate.parent as unknown;
        if (typeof candidateParent === "object" && candidateParent !== null && "client" in candidateParent && "clock" in candidateParent && idKey(candidateParent as { client: number; clock: number }) === idKey(inUpdate.id) && candidate.parentSub === "type") {
          const value = candidate.content?.arr?.[0];
          if (typeof value === "string") return value;
        }
      }
    }
    const existing = layout(doc).blocks.get(blockId)?.get("type");
    return (existing as string | undefined) ?? null;
  };

  const classify = (struct: StructItem): void => {
    from = Math.min(from, struct.id.clock);
    to = Math.max(to, struct.id.clock);
    const chain = resolveRoot(doc, struct, byId);
    if (!chain) return;
    const { root, blockId, viaBlockItem } = chain;
    if (root === "log" || root === "header") return; // bookkeeping, not content
    if (root === "access") {
      accessWrites.value = true;
      return;
    }
    if (root === "blocks" && struct.parent === "blocks") {
      const blockId2 = struct.parentSub ?? "";
      const touch = ensureTouch(blockId2);
      touch.insert = true;
      touch.type = blockTypeOf(blockId2, struct);
      return;
    }
    if (root === "roots" || root === "placement") {
      // placement parentSub is the block; roots entries are ids in content
      const target = root === "placement" ? struct.parentSub : firstBlockIdIn(struct);
      if (target) {
        const touch = ensureTouch(target);
        touch.placement = true;
        if (touch.type === null) touch.type = blockTypeOf(target, undefined);
      }
      return;
    }
    if (root === "blocks" && blockId) {
      void viaBlockItem;
      const touch = ensureTouch(blockId);
      touch.fieldsOrText = true;
      if (touch.type === null) touch.type = blockTypeOf(blockId, undefined);
      return;
    }
  };

  for (const struct of structs) classify(struct);

  // Deletes: resolve each deleted item to its block via the store.
  const dsClients = (decoded.ds?.clients as Map<number, Array<{ clock: number; len: number } | [number, number]>> | undefined);
  if (dsClients) {
    for (const ranges of dsClients.values()) {
      for (const range of ranges ?? []) {
        const clock = Array.isArray(range) ? range[0]! : range.clock;
        const len = Array.isArray(range) ? range[1]! : range.len;
        for (let i = 0; i < (Number(len) || 1); i++) {
          const touched = deletedItemTouches(doc, clock + i, dsClientIdOf(dsClients, range));
          for (const blockId of touched) {
            const touch = ensureTouch(blockId);
            touch.deleted = true;
            touch.placement = true;
            if (touch.type === null) touch.type = blockTypeOf(blockId, undefined);
          }
        }
      }
    }
  }

  const touched: Touched = {
    inserts: [...blockTouches.values()].some((t) => t.insert)
      ? [...blockTouches.entries()].filter(([, t]) => t.insert).map(([, t]) => t.type ?? "unknown")
      : [],
    structuralOps: [...blockTouches.entries()].some(([id, t]) => (t.placement || t.deleted) && !isSuggestion(t, id, doc)),
    otherContentOps: [...blockTouches.entries()].some(([id, t]) => (t.fieldsOrText || t.insert) && !isSuggestion(t, id, doc)),
    accessWrites: accessWrites.value,
    deletedBlocks: [...blockTouches.entries()].filter(([, t]) => t.deleted).map(([id]) => id),
  };
  return { touched, blockTouches, foreignClients, clockRange: { from: from === Number.POSITIVE_INFINITY ? 0 : from, to: to === Number.NEGATIVE_INFINITY ? -1 : to } };
}

function isSuggestion(touch: BlockTouch, blockId: string, doc: Y.Doc): boolean {
  const type = touch.type ?? (layout(doc).blocks.get(blockId)?.get("type") as string | undefined) ?? null;
  return type === "nooq.suggestion/v1";
}

function firstBlockIdIn(struct: StructItem): string | null {
  const value = struct.content?.arr?.[0];
  return typeof value === "string" ? value : null;
}

function dsClientIdOf(clients: Map<number, unknown>, range: unknown): number {
  for (const [client, ranges] of clients) {
    if ((ranges as unknown[]).includes(range)) return client;
  }
  return -1;
}

function deletedItemTouches(doc: Y.Doc, clock: number, client: number): string[] {
  if (client < 0) return [];
  const structs = (doc.store as unknown as { clients: Map<number, Array<{ id: { clock: number }; parent: unknown; parentSub: string | null }>> }).clients.get(client);
  if (!structs) return [];
  const item = structs.find((candidate) => candidate.id.clock === clock);
  if (!item) return [];
  const chain = resolveRoot(doc, item as StructItem, new Map());
  if (!chain?.blockId) return chain?.root === "placement" ? [item.parentSub ?? ""] : [];
  return [chain.blockId];
}

function idKey(id: { client: number; clock: number }): string {
  return `${id.client}:${id.clock}`;
}

/** Resolve a struct's root name and owning block through its parent chain. */
function resolveRoot(
  doc: Y.Doc,
  struct: StructItem,
  byId: Map<string, StructItem>,
): { root: string; blockId: string | null; viaBlockItem: boolean } | null {
  let current: StructItem | undefined = struct;
  let blockId: string | null = null;
  let viaBlockItem = false;
  for (let depth = 0; current && depth < 128; depth++) {
    const parent = current.parent;
    if (typeof parent === "string") {
      if (parent === "blocks" && current.parentSub) {
        blockId = current.parentSub;
        viaBlockItem = true;
      }
      return { root: parent, blockId, viaBlockItem };
    }
    if (parent !== null && parent !== undefined) {
      if (looksLikeId(parent)) {
        // Unapplied item: parent is the creating item's ID.
        const parentStruct = byId.get(idKey(parent as { client: number; clock: number })) ?? storeItem(doc, parent as { client: number; clock: number });
        if (!parentStruct) return { root: "?", blockId: null, viaBlockItem };
        const asItem = parentStruct as StructItem;
        if (asItem.parent === "blocks" && asItem.parentSub) {
          blockId = asItem.parentSub;
          viaBlockItem = true;
        }
        current = asItem;
        continue;
      }
      // Applied item: parent is a live Yjs type instance. Resolve it
      // against our known layout by identity.
      const resolved = rootOfType(doc, parent as object);
      if (resolved) return { root: resolved.root, blockId: resolved.blockId ?? blockId, viaBlockItem: resolved.blockId !== null };
      return { root: "?", blockId: null, viaBlockItem };
    }
    // parent null: ancestry rides the origin (left) or rightOrigin (right
    // neighbor) chain back to an item that carries the parent — Yjs derives
    // parents from either neighbor when neither is encoded.
    const origin = current.origin ?? null;
    const rightOrigin = (current as StructItem).rightOrigin ?? null;
    const neighbor = origin ?? rightOrigin;
    if (neighbor === null) return { root: "?", blockId: null, viaBlockItem };
    const neighborStruct = byId.get(idKey(neighbor)) ?? storeItem(doc, neighbor);
    if (!neighborStruct) return { root: "?", blockId: null, viaBlockItem };
    current = neighborStruct as StructItem;
  }
  return null;
}

function looksLikeId(value: unknown): value is { client: number; clock: number } {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as { client?: unknown }).client === "number" &&
    typeof (value as { clock?: unknown }).clock === "number"
  );
}

/** Resolve a live Yjs type instance to our layout's root name and block. */
function rootOfType(doc: Y.Doc, type: object): { root: string; blockId: string | null } | null {
  if (type === (doc.getMap("access") as unknown as object)) return { root: "access", blockId: null };
  if (type === (doc.getMap("placement") as unknown as object)) return { root: "placement", blockId: null };
  if (type === (doc.getArray("log") as unknown as object)) return { root: "log", blockId: null };
  if (type === (doc.getArray("roots") as unknown as object)) return { root: "roots", blockId: null };
  const blocks = doc.getMap<Y.Map<unknown>>("blocks");
  for (const [blockId, block] of blocks.entries()) {
    if (block === (type as unknown as Y.Map<unknown>)) return { root: "blocks", blockId };
    if (block.get("text") === type) return { root: "blocks", blockId };
    if (block.get("children") === type) return { root: "blocks", blockId };
    if (block.get("fields") === type) return { root: "blocks", blockId };
  }
  return null;
}

function storeItem(doc: Y.Doc, id: { client: number; clock: number }): StructItem | undefined {
  const structs = (doc.store as unknown as { clients: Map<number, Array<{ id: { clock: number } }>> }).clients.get(id.client);
  if (!structs) return undefined;
  let lo = 0;
  let hi = structs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = structs[mid]!;
    if (candidate.id.clock <= id.clock) lo = mid + 1;
    else hi = mid - 1;
  }
  const found = hi >= 0 ? structs[hi]! : undefined;
  return found && found.id.clock <= id.clock ? (found as unknown as StructItem) : undefined;
}

export interface Admission {
  verdict: Verdict;
  reason?: string;
  touched?: Touched;
}

/** verify → authorize → apply. Identical on every peer (SW-1.2). */
export async function admitEnvelope(
  doc: Y.Doc,
  envelope: Envelope,
  update: Uint8Array,
  options: { openKeys?: Map<string, Uint8Array> } = {},
): Promise<Admission> {
  // Tampered bytes never match their envelope (DM-12).
  if ((await updateDigestOf(update)) !== envelope.updateDigest) {
    return { verdict: "deny", reason: "update digest mismatch" };
  }
  const inspected = inspectUpdate(doc, update);
  // Single-client, contiguous declared range (DM-12).
  for (const struct of (Y.decodeUpdate(update) as unknown as { structs: Array<{ id: { client: number; clock: number } }> }).structs) {
    if (struct.id.client !== envelope.client) {
      return { verdict: "deny", reason: `struct from client ${struct.id.client}, envelope declares ${envelope.client}` };
    }
    if (struct.id.clock < envelope.clocks.from || struct.id.clock > envelope.clocks.to) {
      return { verdict: "deny", reason: `clock ${struct.id.clock} outside declared ${envelope.clocks.from}..${envelope.clocks.to}` };
    }
  }

  // DM-13: an adoption's ops must canonically equal the proposal's ops —
  // verified here, not promised by the accept path.
  if (envelope.tx.adoptedBy) {
    const settlement = await adoptionSettlement(doc, envelope.tx);
    if (settlement === false) return { verdict: "deny", reason: "adoption ops diverge from the proposal" };
  }

  const access = readState(doc).access;
  if (access) {
    const key = keyFor(access, envelope.signer);
    if (key) {
      const valid = await verifyEnvelope(envelope, documentHeader(doc).docId, key);
      if (!valid) return { verdict: "deny", reason: "signature" };
      const verdict = authorize(access, { tx: envelope.tx, signer: envelope.signer, signerKey: toB64(key) }, inspected.touched);
      if (verdict !== "allow") return { verdict, reason: verdict === "hold" ? "signer not granted yet" : "role", touched: inspected.touched };
    } else {
      const verdict = authorize(access, { tx: envelope.tx, signer: envelope.signer }, inspected.touched);
      if (verdict !== "hold") return { verdict, reason: "unknown signer" };
      return { verdict, reason: "signer not granted yet", touched: inspected.touched };
    }
  } else if (options.openKeys) {
    const key = options.openKeys.get(envelope.signer);
    if (key && !(await verifyEnvelope(envelope, documentHeader(doc).docId, key))) {
      return { verdict: "deny", reason: "signature" };
    }
  }

  Y.applyUpdate(doc, update, ADMIT_ORIGIN);
  return { verdict: "allow", touched: inspected.touched };
}

/** The settlement ops every accept/reject appends after the proposal's ops. */
function isSettlementOp(op: import("@nooq/core").Op): boolean {
  return (
    (op.op === "setField" && op.key === "status") ||
    op.op === "delete"
  );
}

async function adoptionSettlement(doc: Y.Doc, tx: import("@nooq/core").Transaction): Promise<boolean | undefined> {
  const view = readState(doc);
  const suggestionIds = new Set<string>();
  for (const op of tx.ops) {
    if (op.op === "setField" && op.key === "status" && view.blocks[op.block]?.type === "nooq.suggestion/v1") {
      suggestionIds.add(op.block);
    }
  }
  if (suggestionIds.size === 0) return undefined; // not an adoption we can check
  for (const suggestionId of suggestionIds) {
    const proposal = view.blocks[suggestionId]?.fields.proposal as { ops?: import("@nooq/core").Op[] } | undefined;
    if (!proposal?.ops) return false;
    const adopted = tx.ops.filter((op) => !isSettlementOp(op));
    const { canonicalJson } = await import("@nooq/core");
    if (canonicalJson(adopted) !== canonicalJson(proposal.ops)) return false;
  }
  return true;
}

function keyFor(access: Access, actorId: string): Uint8Array | undefined {
  if (access.owner.actorId === actorId) return fromB64(access.owner.key);
  for (const grant of access.grants) {
    if (grant.actorId === actorId) return fromB64(grant.key);
  }
  return undefined;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
