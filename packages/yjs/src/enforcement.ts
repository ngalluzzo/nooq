/**
 * Enforcement — DM-12/13 in the adapter.
 *
 * commitSigned: run a validated transaction with a known origin, capture
 * exactly its incremental update, and seal it in a signed envelope.
 *
 * inspectUpdate: pure classification of an update's structs into what
 * DM-13's authorize() needs (which blocks, what kinds of writes, whose
 * deletes). Deterministic for causally ready updates: parents resolve
 * within the update itself or against the local store, and anything the
 * receiver cannot see yet is `unresolved` — held, never authorized.
 *
 * admitEnvelope: verify → authorize → apply, identically on every peer.
 * Invalid envelopes are never applied; ungranted signers hold.
 */

import * as Y from "yjs";
import {
  authorize,
  adoptionMatchesState,
  isGenesisFor,
  isSecuredDocId,
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
  // A loop, not Math.min(...spread): large pastes exceed the argument limit.
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const struct of decoded.structs) {
    if (struct.id.client !== client) continue;
    from = Math.min(from, struct.id.clock);
    to = Math.max(to, struct.id.clock);
  }
  return from === Number.POSITIVE_INFINITY ? { from: 0, to: -1 } : { from, to };
}

type Id = { client: number; clock: number };

interface StructItem {
  id: Id;
  /** Encoded: root name, parent item ID, or null (derived from a neighbor). Applied: the live parent type. */
  parent: unknown;
  /** Left origin: the previous item on this key/sequence, null for the first. */
  origin?: Id | null;
  /** Right origin: the next item, set for inserts with a right neighbor. */
  rightOrigin?: Id | null;
  /** Map key; encoded only alongside an explicit parent. */
  parentSub: string | null;
  /** Clock units the struct spans. */
  length?: number;
  content?: { arr?: unknown[] } & Record<string, unknown>;
  constructor: { name: string };
}

interface BlockTouch {
  type: string | null;
  insert: boolean;
  fieldsOrText: boolean;
  placement: boolean;
  deleted: boolean;
}

/** Where a struct lives in the document layout. */
interface Resolution {
  /** Root type name, or "?" when the receiver cannot see the parent yet. */
  root: string;
  /** The block this struct belongs to, if any. */
  blockId: string | null;
  /** The struct is an entry of the root type itself. */
  direct: boolean;
  /** Effective map key: encoded, or inherited from the anchoring neighbor. */
  sub: string | null;
}

const KNOWN_ROOTS = new Set(["blocks", "roots", "placement", "access", "log"]);
const UNSEEN: Resolution = { root: "?", blockId: null, direct: false, sub: null };
/** The layout nests a few levels (blocks → block → fields/text/children); deeper is crafted. */
const NESTING = 32;
/** GC and Skip structs carry no parent or content: nothing to classify or delete. */
const isFiller = (struct: StructItem) => struct.constructor.name === "GC" || struct.constructor.name === "Skip";

/**
 * Classify an update's effects for authorize() (DM-12/13). Every struct
 * and every delete is resolved to a layout root; a target the receiver
 * cannot see yet makes the whole update `unresolved`.
 */
export function inspectUpdate(
  doc: Y.Doc,
  update: Uint8Array,
): { touched: Touched; blockTouches: Map<string, BlockTouch>; foreignClients: Set<number>; clockRange: { from: number; to: number } } {
  const decoded = Y.decodeUpdate(update) as unknown as { structs: StructItem[]; ds: { clients?: Map<number, unknown[]> } };
  const structs = decoded.structs ?? [];
  const local = byClient(structs);
  const resolve = resolver(doc, local);

  const blockTouches = new Map<string, BlockTouch>();
  const accessValues: unknown[] = [];
  const logEntries: unknown[] = [];
  const flags = { access: false, bookkeeping: false, unresolved: false, strayStructure: false, strayContent: false };
  const foreignClients = new Set<number>();
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  const ensureTouch = (blockId: string): BlockTouch => {
    let touch = blockTouches.get(blockId);
    if (!touch) {
      touch = { type: null, insert: false, fieldsOrText: false, placement: false, deleted: false };
      blockTouches.set(blockId, touch);
    }
    if (touch.type === null) touch.type = (layout(doc).blocks.get(blockId)?.get("type") as string | undefined) ?? null;
    return touch;
  };

  /** A new block map's type, from the update's own `type` entry. */
  const insertedType = (blockItem: StructItem): string | null => {
    for (const candidate of structs) {
      const parent = candidate.parent as unknown;
      if (looksLikeId(parent) && idKey(parent) === idKey(blockItem.id) && candidate.parentSub === "type") {
        const value = candidate.content?.arr?.[0];
        if (typeof value === "string") return value;
      }
    }
    return null;
  };

  const classify = (struct: StructItem): void => {
    if (isFiller(struct)) return;
    from = Math.min(from, struct.id.clock);
    to = Math.max(to, struct.id.clock);
    const at = resolve(struct);
    if (at.root === "?") {
      flags.unresolved = true; // DM-12: never authorize on a partial view
      return;
    }
    if (!KNOWN_ROOTS.has(at.root)) {
      flags.bookkeeping = true; // DM-12: writes outside the document's own roots
      return;
    }
    const values = Array.isArray(struct.content?.arr) ? struct.content!.arr! : undefined;
    switch (at.root) {
      case "log":
        // DM-12: every appended value counts — exactly one, equal to tx.
        if (at.direct && values) logEntries.push(...values);
        else flags.bookkeeping = true;
        return;
      case "access":
        flags.access = true;
        if (at.direct && at.sub === "access" && values) accessValues.push(...values);
        else flags.bookkeeping = true; // any other key or shape in the access map
        return;
      case "roots":
        if (at.direct && values && values.length > 0 && values.every((id) => typeof id === "string")) {
          for (const id of values as string[]) ensureTouch(id).placement = true;
        } else {
          flags.strayStructure = true;
        }
        return;
      case "placement":
        if (at.direct && at.sub) ensureTouch(at.sub).placement = true;
        else flags.strayStructure = true;
        return;
      case "blocks":
        if (at.direct && at.sub) {
          const touch = ensureTouch(at.sub);
          touch.insert = true;
          touch.type = insertedType(struct);
        } else if (at.blockId) {
          ensureTouch(at.blockId).fieldsOrText = true;
        } else {
          flags.strayContent = true;
        }
        return;
    }
  };

  for (const struct of structs) classify(struct);

  // Deletes: walk every struct each range covers — in the update itself or
  // the local store — by span, so a range costs its structs, not its clocks.
  const dsClients = decoded.ds?.clients as Map<number, Array<{ clock: number; len: number } | [number, number]>> | undefined;
  for (const [client, ranges] of dsClients ?? []) {
    for (const range of ranges ?? []) {
      let clock = Array.isArray(range) ? range[0]! : range.clock;
      const end = clock + (Number(Array.isArray(range) ? range[1]! : range.len) || 1);
      while (clock < end) {
        const struct = containing(doc, local, { client, clock });
        if (!struct) {
          flags.unresolved = true; // deleting something we cannot see
          break;
        }
        clock = struct.id.clock + (struct.length ?? 1);
        if (isFiller(struct)) continue;
        const at = resolve(struct);
        if (at.root === "?") {
          flags.unresolved = true;
          break;
        }
        if (at.root === "log" || !KNOWN_ROOTS.has(at.root)) {
          flags.bookkeeping = true; // DM-12: log deletes and unknown-root deletes
          continue;
        }
        if (at.root === "access") {
          flags.access = true; // DM-13: deleting access is an access write
          continue;
        }
        const values = Array.isArray(struct.content?.arr) ? struct.content!.arr! : [];
        const targets = at.root === "roots"
          ? values.filter((id): id is string => typeof id === "string")
          : [at.root === "placement" || (at.root === "blocks" && at.direct) ? at.sub : at.blockId].filter((id): id is string => !!id);
        if (targets.length === 0) {
          flags.strayStructure = true;
          continue;
        }
        for (const blockId of targets) {
          const touch = ensureTouch(blockId);
          touch.deleted = true;
          touch.placement = true;
        }
      }
    }
  }

  // Suggesters may create and attach suggestion blocks (DM-13): a touch is
  // theirs only when this very update inserts that suggestion block.
  const created = (id: string, t: BlockTouch) => t.insert && isSuggestion(t, id, doc);
  const touched: Touched = {
    inserts: [...blockTouches.values()].filter((t) => t.insert).map((t) => t.type ?? "unknown"),
    structuralOps: flags.strayStructure || [...blockTouches.entries()].some(([id, t]) => (t.placement || t.deleted) && !created(id, t)),
    otherContentOps: flags.strayContent || [...blockTouches.entries()].some(([id, t]) => (t.fieldsOrText || t.insert) && !created(id, t)),
    accessWrites: flags.access,
    deletedBlocks: [...blockTouches.entries()].filter(([, t]) => t.deleted).map(([id]) => id),
    unresolved: flags.unresolved,
    bookkeepingWrites: flags.bookkeeping,
    logEntries,
    accessValues,
  };
  return { touched, blockTouches, foreignClients, clockRange: { from: from === Number.POSITIVE_INFINITY ? 0 : from, to: to === Number.NEGATIVE_INFINITY ? -1 : to } };
}

function isSuggestion(touch: BlockTouch, blockId: string, doc: Y.Doc): boolean {
  const type = touch.type ?? (layout(doc).blocks.get(blockId)?.get("type") as string | undefined) ?? null;
  return type === "nooq.suggestion/v1";
}

function idKey(id: Id): string {
  return `${id.client}:${id.clock}`;
}

function looksLikeId(value: unknown): value is Id {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as { client?: unknown }).client === "number" &&
    typeof (value as { clock?: unknown }).clock === "number"
  );
}

/** The update's own structs per client, sorted by clock, for span lookup. */
function byClient(structs: StructItem[]): Map<number, StructItem[]> {
  const out = new Map<number, StructItem[]>();
  for (const struct of structs) {
    const list = out.get(struct.id.client) ?? [];
    list.push(struct);
    out.set(struct.id.client, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  return out;
}

/** The struct whose span covers `id`: the update's own first, then the store. */
function containing(doc: Y.Doc, local: Map<number, StructItem[]>, id: Id): StructItem | undefined {
  const store = (doc.store as unknown as { clients: Map<number, StructItem[]> }).clients.get(id.client);
  return spanOf(local.get(id.client), id.clock) ?? spanOf(store, id.clock);
}

function spanOf(structs: StructItem[] | undefined, clock: number): StructItem | undefined {
  if (!structs) return undefined;
  let lo = 0;
  let hi = structs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (structs[mid]!.id.clock <= clock) lo = mid + 1;
    else hi = mid - 1;
  }
  const found = hi >= 0 ? structs[hi] : undefined;
  return found && clock < found.id.clock + (found.length ?? 1) ? found : undefined;
}

/**
 * Resolve structs to layout roots. Neighbor chains (items whose parent Yjs
 * derives from origin/rightOrigin) are memoized, so a long run of inserts
 * resolves in linear time with no length limit; nesting stays bounded.
 */
function resolver(doc: Y.Doc, local: Map<number, StructItem[]>): (struct: StructItem) => Resolution {
  const anchors = new Map<StructItem, StructItem | null>();
  const resolved = new Map<StructItem, Resolution>();

  /** The struct that carries this one's parent: itself or the end of its neighbor chain. */
  const anchorOf = (start: StructItem): StructItem | null => {
    const path: StructItem[] = [];
    const seen = new Set<StructItem>();
    let current = start as StructItem | undefined;
    let anchor: StructItem | null = null;
    while (current) {
      const known = anchors.get(current);
      if (known !== undefined) {
        anchor = known;
        break;
      }
      if (seen.has(current) || isFiller(current)) break; // crafted cycle or no parent: unresolvable
      seen.add(current);
      path.push(current);
      if (current.parent !== null && current.parent !== undefined) {
        anchor = current;
        break;
      }
      const neighbor = current.origin ?? current.rightOrigin ?? null;
      current = neighbor ? containing(doc, local, neighbor) : undefined;
    }
    for (const item of path) anchors.set(item, anchor);
    return anchor;
  };

  /** A child's resolution from its holder's. */
  const under = (holder: Resolution, sub: string | null): Resolution =>
    holder.root === "?" ? UNSEEN : { root: holder.root, blockId: holder.direct && holder.root === "blocks" ? holder.sub : holder.blockId, direct: false, sub };

  const resolve = (struct: StructItem, depth: number): Resolution => {
    const cached = resolved.get(struct);
    if (cached) return cached;
    let result = UNSEEN;
    const anchor = depth > NESTING ? null : anchorOf(struct);
    if (anchor) {
      const parent = anchor.parent;
      const sub = anchor.parentSub ?? null;
      if (typeof parent === "string") {
        // Encoded with its root's name.
        result = { root: parent, blockId: null, direct: true, sub };
      } else if (looksLikeId(parent)) {
        // Encoded with the ID of the item holding its parent type.
        const holder = containing(doc, local, parent);
        if (holder) result = under(resolve(holder, depth + 1), sub);
      } else if (parent && typeof parent === "object") {
        // Applied: the live parent type — a root, or a type held by an item.
        const holder = (parent as { _item?: StructItem | null })._item;
        if (holder === null) {
          const name = rootName(doc, parent);
          if (name) result = { root: name, blockId: null, direct: true, sub };
        } else if (holder) {
          result = under(resolve(holder, depth + 1), sub);
        }
      }
    }
    resolved.set(struct, result);
    return result;
  };

  return (struct) => resolve(struct, 0);
}

/** A root type's name in this document. */
function rootName(doc: Y.Doc, type: unknown): string | null {
  for (const [name, candidate] of doc.share) {
    if (candidate === type) return name;
  }
  return null;
}

function storeItem(doc: Y.Doc, id: Id): StructItem | undefined {
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

  // Self-admission / echo: every declared struct is already integrated
  // locally (the committer applies before sealing; duplicates arrive from
  // rebroadcast). Idempotent allow — the rules govern replication, and a
  // malicious committer's own doc was never anyone else's problem.
  let alreadyIntegrated = true;
  for (const struct of (Y.decodeUpdate(update) as unknown as { structs: Array<{ id: { client: number; clock: number }; length: number }> }).structs) {
    const present = storeItem(doc, struct.id) as (StructItem & { length?: number }) | undefined;
    if (!present) {
      alreadyIntegrated = false;
      break;
    }
    // Span coverage: the stored item must CONTAIN this clock, not merely
    // precede it (a peer with clocks 0..1 does not have clock 2).
    const start = present.id.clock;
    const span = present.length ?? 1;
    if (struct.id.clock < start || struct.id.clock >= start + span) {
      alreadyIntegrated = false;
      break;
    }
  }
  if (alreadyIntegrated && (Y.decodeUpdate(update) as unknown as { structs: unknown[] }).structs.length > 0) {
    return { verdict: "allow", reason: "duplicate", touched: inspected.touched };
  }

  // DM-13: an adoption's ops must canonically equal the proposal's ops —
  // verified here, not promised by the accept path.
  if (envelope.tx.adoptedBy) {
    const settlement = adoptionMatchesState(readState(doc), envelope.tx);
    if (settlement === false) return { verdict: "deny", reason: "adoption ops diverge from the proposal" };
    if (settlement === undefined) return { verdict: "hold", reason: "awaiting proposal" };
  }

  const docId = documentHeader(doc).docId;

  // DM-13 Draft 1.7: secured or open is decided by the document's ID alone.
  if (isSecuredDocId(docId)) {
    const access = readState(doc).access;
    if (!access) {
      // Before genesis, only the genesis envelope admits: one access value
      // whose owner and nonce derive this document's ID (isGenesisFor).
      const genesis = inspected.touched.accessValues[0];
      if (
        inspected.touched.accessWrites &&
        inspected.touched.accessValues.length === 1 &&
        (await isGenesisFor(docId, genesis))
      ) {
        const owner = (genesis as import("@nooq/core").Access).owner;
        if (envelope.signer !== owner.actorId) return { verdict: "deny", reason: "genesis signer is not the owner" };
        const valid = await verifyEnvelope(envelope, docId, fromB64(owner.key));
        if (!valid) return { verdict: "deny", reason: "genesis signature" };
        Y.applyUpdate(doc, update, ADMIT_ORIGIN);
        return { verdict: "allow", touched: inspected.touched };
      }
      return { verdict: "hold", reason: "awaiting genesis", touched: inspected.touched };
    }
    // Secured and past genesis.
    const party = keyFor(access, envelope.signer);
    if (party) {
      const valid = await verifyEnvelope(envelope, docId, party);
      if (!valid) return { verdict: "deny", reason: "signature", touched: inspected.touched };
      const verdict = authorize(access, { tx: envelope.tx, signer: envelope.signer, signerKey: toB64(party) }, inspected.touched);
      if (verdict !== "allow") {
        return { verdict, reason: verdict === "hold" ? "unresolved or ungranted" : "rules", touched: inspected.touched };
      }
    } else {
      // Unknown signer: cannot verify against a grant — hold, never deny on
      // a partial view (a later grant may name them).
      return { verdict: "hold", reason: "signer not granted yet", touched: inspected.touched };
    }
    Y.applyUpdate(doc, update, ADMIT_ORIGIN);
    return { verdict: "allow", touched: inspected.touched };
  }

  // Open documents: no rules but the CRDT's — and never access (DM-13).
  if (inspected.touched.accessWrites) {
    return { verdict: "deny", reason: "an open document never gains access" };
  }
  if (options.openKeys) {
    const key = options.openKeys.get(envelope.signer);
    if (key && !(await verifyEnvelope(envelope, docId, key))) {
      return { verdict: "deny", reason: "signature" };
    }
  }
  Y.applyUpdate(doc, update, ADMIT_ORIGIN);
  return { verdict: "allow", touched: inspected.touched };
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
