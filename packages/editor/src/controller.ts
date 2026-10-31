/**
 * Editor controller — the headless half of the reference editor.
 *
 * Everything here is composed from PUBLIC framework API: nooq
 * transactions (DM-4) onto the Yjs adapter, suggestion lifecycle
 * (DM-6.3/6.4), and an optional sync session (SW-3). If this controller
 * ever needs something a third party cannot call, that is a bug in the
 * framework (PHILOSOPHY §1/§7).
 *
 * No transport? Everything works — offline is the default state (§2).
 */

import * as Y from "yjs";
import {
  acceptChecked,
  computeDigests,
  evaluateSuggestion,
  liveTree,
  makeBlock,
  makeSuggestionBlock,
  newBlockId,
  rejectTransaction,
  rootDigest,
  type ActorDescriptor,
  type BlockId,
  type DocState,
  type Evaluation,
  type JsonValue,
  type Op,
  type Proposal,
  type RenderedText,
  type TextChange,
  type Transaction,
} from "@nooq/core";
import { replaceChanges } from "@nooq/core";
import { applyCaptured, applyTransaction as applyToDoc, newDocument, readState, sealEnvelope } from "@nooq/yjs";
import { SyncSession, type AwarenessEntry, type SyncTransport } from "@nooq/sync";

export interface EditorOptions {
  docId: string;
  /** The local writer. */
  actor: { actorId: string; name?: string };
  /** Absent: a local document with no peers — fully functional (§2). */
  transport?: SyncTransport;
  /** DM-12: the writer's Ed25519 key. Present => transactions ship signed. */
  key?: import("@nooq/core").ActorKey;
  /** The simulated model plugin's key (a suggester, DM-13). */
  aiKey?: import("@nooq/core").ActorKey;
}

export interface ProposeOptions {
  /** Exact ops (DM-6.3: applied verbatim on accept). */
  ops: Op[];
  /** Blocks the proposal is pinned against (DM-6.1 evidence). */
  evidence: readonly BlockId[];
  /** The proposing AI actor. */
  actor: { actorId: string; name: string; model: string };
  intent?: string;
}

/**
 * Convention of the reference editor (v1): actor IDs carry their kind as a
 * prefix ("ai:…", "human:…"). Block attribution stores actor IDs only
 * (DM-5); carrying the kind there is an open model question, not a wire fact.
 */
export function actorKindOf(actorId: string): "human" | "ai" | "system" {
  if (actorId.startsWith("ai:")) return "ai";
  if (actorId.startsWith("human:")) return "human";
  return "system"; // importers, migrations, and anything else (DM-5 kinds)
}

export class Editor {
  readonly ydoc: Y.Doc;
  /** Latest awareness per remote actor (SW-7); never document state. */
  readonly awareness = new Map<string, AwarenessEntry>();
  private readonly session: SyncSession | null;
  private readonly listeners = new Set<() => void>();
  private lamport = 0;
  private notifyScheduled = false;

  constructor(private readonly options: EditorOptions) {
    this.ydoc = newDocument(options.docId);
    this.session = options.transport
      ? new SyncSession({
          doc: this.ydoc,
          transport: options.transport,
          actor: options.actor.actorId,
          ...(options.actor.name !== undefined ? { name: options.actor.name } : {}),
          onSynced: () => this.scheduleNotify(),
          onAwareness: (entry) => {
            this.awareness.set(entry.actor, entry);
            this.scheduleNotify();
          },
        })
      : null;
    this.ydoc.on("update", () => this.scheduleNotify());
    this.session?.start();
  }

  get docId(): string {
    return this.options.docId;
  }

  get hasTransport(): boolean {
    return this.session !== null;
  }

  get synced(): boolean {
    return this.session?.synced ?? false;
  }

  /** The projection IS the engine view (DM-9): every core function works on it. */
  get view(): DocState {
    return readState(this.ydoc);
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * The one entry point (§1): apply a nooq transaction. In signed mode the
   * document mutates synchronously (EB-6: typing never waits); the envelope
   * seals and ships a microtask later, so the wire always carries it.
   */
  apply(tx: Transaction): void {
    this.lamport = Math.max(this.lamport, tx.lamport);
    if (this.options.key && this.session) {
      // The signer is not always the author: adoptions are authored by the
      // proposing AI but signed by the accepting writer (DM-6.3, DM-13).
      const aiAuthored = tx.actor.actorId.startsWith("ai:");
      const key = aiAuthored && !tx.adoptedBy && this.options.aiKey ? this.options.aiKey : this.options.key;
      const signer = tx.adoptedBy ?? tx.actor.actorId;
      const captured = applyCaptured(this.ydoc, tx, key, signer);
      void this.ship(captured);
      return;
    }
    applyToDoc(this.ydoc, tx);
  }

  private async ship(commit: { tx: Transaction; update: Uint8Array; key: import("@nooq/core").ActorKey; signer: string }): Promise<void> {
    try {
      const sealed = await sealEnvelope(this.ydoc, commit.tx, commit.update, commit.key, commit.signer);
      this.session?.sendUpdate(commit.update, sealed);
    } catch {
      // Signing failures surface via the session's error channel; the local
      // document is already consistent.
    }
  }

  private tx(ops: Op[], intent?: string): Transaction {
    return {
      id: newBlockId(),
      actor: { actorId: this.options.actor.actorId, kind: "human" },
      lamport: ++this.lamport,
      causality: {},
      ...(intent !== undefined ? { intent } : {}),
      ops,
    };
  }

  // ---- blocks (public ops only) ----

  insertBlock(init: {
    type: string;
    parent: BlockId | null;
    index?: number;
    fields?: Record<string, JsonValue>;
    text?: string;
  }): BlockId {
    const block = makeBlock(
      { type: init.type, ...(init.fields ? { fields: init.fields } : {}), ...(init.text !== undefined ? { text: unmarked(init.text) } : {}) },
      this.options.actor.actorId,
    );
    this.apply(this.tx([{ op: "insert", block, parent: init.parent, ...(init.index !== undefined ? { index: init.index } : {}) }], `insert:${init.type}`));
    return block.id;
  }

  /** DM-4.3: splice steps applied directly — keystroke cost proportional to the edit. */
  applyTextChanges(block: BlockId, changes: readonly TextChange[]): void {
    this.apply(this.tx([{ op: "textEdit", block, changes: [...changes] } as Op], "type"));
  }

  /** Whole-string editing convenience: diffs old -> new into minimal splices (DM-4.3). */
  editText(block: BlockId, s: string): void {
    const before = this.view.blocks[block]?.text?.s ?? "";
    this.applyTextChanges(block, replaceChanges(before, s));
  }

  deleteBlock(block: BlockId): void {
    this.apply(this.tx([{ op: "delete", block }], "delete"));
  }

  restoreBlock(block: BlockId, parent: BlockId | null): void {
    this.apply(this.tx([{ op: "restore", block, parent }], "restore"));
  }

  moveBlock(block: BlockId, newParent: BlockId | null, index?: number): void {
    this.apply(this.tx([{ op: "move", block, newParent, ...(index !== undefined ? { index } : {}) }], "move"));
  }

  setField(block: BlockId, key: string, value: JsonValue): void {
    this.apply(this.tx([{ op: "setField", block, key, value }], `field:${key}`));
  }

  /** DM-13: install the access header (owner-signed; the op validates shape). */
  setAccess(access: import("@nooq/core").Access): void {
    this.apply(this.tx([{ op: "setAccess", access }], "set-access"));
  }

  // ---- suggestions (DM-6) ----

  /** Build a proposal against the current view and insert it as a suggestion block. */
  async propose(options: ProposeOptions): Promise<BlockId> {
    const view = this.view;
    const digests = await computeDigests(view);
    const evidence = [...options.evidence].sort().map((block) => {
      const info = digests.get(block);
      if (!info) throw new Error(`no digests for evidence block ${block}`);
      return { block, contentDigest: info.contentDigest, structureDigest: info.structureDigest };
    });
    // Display-grade provenance: the exact text each textEdit op was built
    // against, so the card can render the proposal "as proposed" even after
    // the document drifts (DM-6 context is free-form).
    const beforeTexts: Record<string, string> = {};
    for (const op of options.ops) {
      if (op.op === "textEdit") beforeTexts[op.block] = view.blocks[op.block]?.text?.s ?? "";
    }
    const proposal: Proposal = {
      base: { rootDigest: await rootDigest(view) },
      ops: structuredClone(options.ops),
      evidence,
      context: { model: options.actor.model, name: options.actor.name, before: beforeTexts },
      actor: options.actor.actorId,
    };
    const suggestion = makeSuggestionBlock(proposal, options.actor.actorId);
    this.apply({
      id: newBlockId(),
      actor: { actorId: options.actor.actorId, kind: "ai", model: options.actor.model },
      lamport: ++this.lamport,
      causality: {},
      ...(options.intent !== undefined ? { intent: options.intent } : {}),
      ops: [{ op: "insert", block: suggestion, parent: null }],
    });
    return suggestion.id;
  }

  /** DM-6.2/6.5: derived, never stored; recomputed on every render. */
  async evaluate(suggestion: BlockId): Promise<Evaluation> {
    return evaluateSuggestion(this.view, suggestion);
  }

  /** DM-6.3. Throws StaleSuggestionError unless fresh or force. */
  async accept(suggestion: BlockId, options: { force?: boolean } = {}): Promise<Transaction> {
    const tx = await acceptChecked({
      state: this.view,
      suggestion,
      actor: this.localActor(),
      lamport: ++this.lamport,
      force: options.force,
    });
    this.apply(tx);
    return tx;
  }

  /** DM-6.4. */
  reject(suggestion: BlockId): void {
    this.apply(
      rejectTransaction({ suggestion, actor: this.localActor(), lamport: ++this.lamport }),
    );
  }

  /** Who settled a suggestion (adoption provenance, DM-5), from the log. */
  settledBy(suggestion: BlockId): string | undefined {
    for (let i = this.view.log.length - 1; i >= 0; i--) {
      const tx = this.view.log[i]!;
      const touches = tx.ops.some((op) => "block" in op && op.block === suggestion && op.op === "setField");
      if (touches) return tx.adoptedBy ?? tx.actor.actorId;
    }
    return undefined;
  }

  // ---- awareness (SW-7) ----

  setCursor(cursor: { block: BlockId; offset: number } | null): void {
    this.session?.setCursor(cursor);
  }

  close(): void {
    this.session?.close();
  }

  private localActor(): ActorDescriptor {
    return { actorId: this.options.actor.actorId, kind: "human" };
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const callback of this.listeners) callback();
    });
  }
}

export function unmarked(s: string): RenderedText {
  return { s, marks: s.split("").map(() => []) };
}

/** Document order of alive blocks (surface helper). */
export function aliveInOrder(view: DocState): BlockId[] {
  const out: BlockId[] = [];
  const walk = (ids: readonly BlockId[]): void => {
    for (const id of ids) {
      out.push(id);
      walk(view.blocks[id]?.children ?? []);
    }
  };
  walk(view.roots);
  return out;
}

/** Parent of an alive block, or null for roots (surface helper over liveTree). */
export function parentOf(view: DocState, block: BlockId): BlockId | null | undefined {
  return liveTree(view).parentOf.get(block);
}
