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
  acceptTransaction,
  StaleSuggestionError,
  authorizeLocal,
  canonicalJson,
  isGenesisFor,
  isSecuredDocId,
  toBase64,
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
import { PluginRegistry, PluginRuntime, freezeInPlace, freezeSnapshot, type Plugin, type Command, type CommandResult, type PreparedCommand, type SelectionRequest, type Job, type JobHandle, type PublicationResult, type PluginError, type ChangeEvent } from "@nooq/plugins";
import { layout } from "@nooq/yjs";

export interface JobBinding { job: Job<any, any> | string; actor: ActorDescriptor; signer?: import("@nooq/core").ActorKey }
export class AuthorizationError extends Error {
  constructor(readonly reason: string, readonly retryable: boolean) { super(reason); this.name = "AuthorizationError"; }
}

export interface EditorOptions {
  docId: string;
  /** The local writer. */
  actor: { actorId: string; name?: string; kind?: ActorDescriptor["kind"]; model?: string };
  plugins?: readonly Plugin[];
  resolve?: Readonly<Record<string, string>>;
  jobBindings?: readonly JobBinding[];
  onError?: (error: PluginError) => void;
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
  private readonly eventListeners = new Set<(events: ChangeEvent[]) => void>();
  private lamport = 0;
  private notifyScheduled = false;
  readonly registry: PluginRegistry;
  private readonly runtime: PluginRuntime;
  readonly ready: Promise<void>;
  private revisionValue = 0;
  private closed = false;
  private applying = false;
  private currentTx?: Transaction;
  private readonly events: ChangeEvent[] = [];
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: PluginError) => void>();
  readonly errors: PluginError[] = [];
  private readonly identities = new Map<string, { actor: ActorDescriptor; key?: import("@nooq/core").ActorKey; publicKey?: string; ready: boolean }>();
  private readonly selectionListeners = new Set<(selection: SelectionRequest) => void>();

  readonly commands = {
    batch: <Args>(command: Command<Args> | string, inputs: readonly Args[]): CommandResult => this.runtime.runBatch(command, inputs),
    run: <Args>(command: Command<Args> | string, args: Args, options: { selection?: SelectionRequest } = {}): CommandResult => this.runtime.run(command, args, options) as CommandResult,
    preview: <Args>(command: Command<Args> | string, args: Args, options: { selection?: SelectionRequest } = {}): PreparedCommand | CommandResult => this.runtime.run(command, args, { ...options, preview: true }),
  };
  readonly jobs = { start: <Args, Result>(job: Job<Args, Result> | string, args: Args): JobHandle<Result> => this.runtime.start(job, args) };

  constructor(private readonly options: EditorOptions) {
    this.options = { ...options, actor: Object.freeze({ ...options.actor }) };
    this.registry = new PluginRegistry(options.plugins, options.resolve);
    const addIdentity = (id: string, actor: ActorDescriptor, key?: import("@nooq/core").ActorKey) => {
      this.identities.set(id, { actor: Object.freeze({ ...actor }), ...(key ? { key: { private: key.private, publicBytes: new Uint8Array(key.publicBytes) }, publicKey: toBase64(key.publicBytes) } : {}), ready: !key });
    };
    addIdentity("local", this.localActor(), options.key);
    if (options.aiKey) addIdentity("legacy-ai", { actorId: "legacy-ai", kind: "ai" }, options.aiKey);
    for (const binding of options.jobBindings ?? []) {
      const id = typeof binding.job === "string" ? binding.job : binding.job.id, entry = this.registry.job(id);
      if (!entry || !entry.definition.publishes || this.identities.has(`job:${id}`)) throw new Error(`Invalid or duplicate job binding ${id}`);
      addIdentity(`job:${id}`, { ...binding.actor, plugin: entry.plugin }, binding.signer);
    }
    for (const { definition } of this.registry.jobs) if (definition.publishes && !this.identities.has(`job:${definition.id}`)) throw new Error(`Publishing job ${definition.id} needs a host binding`);
    this.ydoc = newDocument(options.docId);
    this.runtime = new PluginRuntime(this.registry, {
      read: () => this.view, // shared frozen projection: preparer consumes it read-only (EB-6/ref-large)
      readFresh: () => readState(this.ydoc), // mutable: validation scratch (EB-6)
      actor: this.localActor(),
      commit: (prepared, actor) => this.commitCommand(prepared, actor),
      jobActor: id => this.identities.get(`job:${id}`)?.actor,
      publish: (job, proposal, intent) => this.publishJob(job, proposal, intent),
      report: error => this.reportError(error),
    });
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
    const changed = new Set<string>();
    const changes = new Map<string, { fields: Set<string>; text: boolean; structure: boolean }>();
    let rootsChanged = false, accessChanged = false;
    const change = (id: string) => { changed.add(id); if (!changes.has(id)) changes.set(id, { fields: new Set(), text: false, structure: false }); return changes.get(id)!; };
    const parts = layout(this.ydoc);
    parts.blocks.observeDeep(events => {
      for (const event of events) {
        if (event.path.length) {
          const item = change(String(event.path[0]));
          if (event.path[1] === "fields" && event instanceof Y.YMapEvent) for (const key of event.keysChanged) item.fields.add(key);
          else if (event.path[1] === "text") item.text = true;
          else item.structure = true;
        } else if (event instanceof Y.YMapEvent) for (const id of event.keysChanged) change(id).structure = true;
      }
    });
    parts.placement.observe(event => { for (const id of event.keysChanged) change(id).structure = true; });
    parts.roots.observe(() => { rootsChanged = true; });
    parts.access.observe(() => { accessChanged = true; });
    this.ydoc.on("update", (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      this.revisionValue++;
      this.events.push(freezeSnapshot({ revision: this.revisionValue, origin: transaction.local ? "local" : "remote", blocks: [...changed],
        changes: Object.fromEntries([...changes].map(([id, value]) => [id, { ...value, fields: [...value.fields] }])), roots: rootsChanged, access: accessChanged,
        ...(this.currentTx ? { transaction: this.currentTx } : {}) }));
      changed.clear(); changes.clear(); rootsChanged = accessChanged = false; this.scheduleNotify();
    });
    this.ready = Promise.all([...this.identities.values()].map(async identity => {
      if (!identity.key) return;
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const signature = await crypto.subtle.sign("Ed25519", identity.key.private, challenge);
      const publicKey = await crypto.subtle.importKey("raw", new Uint8Array(identity.key.publicBytes), "Ed25519", false, ["verify"]);
      if (!await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)) throw new Error(`Signing key mismatch for ${identity.actor.actorId}`);
      identity.ready = true;
    })).then(() => undefined);
    void this.ready.catch(cause => { this.reportError({ phase: "setup", cause }); this.close(); });
    try { this.runtime.setup(); } catch (error) { this.session?.close(); this.ydoc.destroy(); throw error; }
    this.session?.start();
  }

  get revision(): number { return this.revisionValue; }
  get isClosed(): boolean { return this.closed; }
  diagnose(block: BlockId) { return this.runtime.diagnose(block); }
  onError(listener: (error: PluginError) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  reportError(error: PluginError): void {
    this.errors.push(error);
    for (const listener of [this.options.onError, ...this.errorListeners]) if (listener) try { listener(error); } catch (cause) { console.error("nooq error handler failed", cause); }
  }
  onClose(listener: () => void): () => void { if (this.closed) { listener(); return () => {}; } this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  onSelection(listener: (selection: SelectionRequest) => void): () => void { this.selectionListeners.add(listener); return () => this.selectionListeners.delete(listener); }

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
  /**
   * The shared read-only projection, memoized by revision (EB-6): it was
   * rebuilt ~5x per keystroke across handler, authorize, render and reviews.
   * Mutating it (or its blocks) is a caller bug — freeze it so such a bug
   * throws instead of corrupting the cache. Paths that MUTATE a projection
   * (engine validation, the command preparer) use fresh readState calls.
   */
  private viewCache: { revision: number; value: DocState } | undefined;
  get view(): DocState {
    const cache = this.viewCache?.revision === this.revisionValue ? this.viewCache : (this.viewCache = { revision: this.revisionValue, value: freezeInPlace(readState(this.ydoc)) as unknown as DocState }); // Immutable typed as DocState: reads compile, mutation throws at runtime
    return cache.value;
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Detailed change batches (origin, block ids, text/fields/structure) —
   * the surface renders only what changed; a null-flag batch means
   * "re-render everything" (initial, access).
   */
  onEvents(callback: (events: ChangeEvent[]) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * The one entry point (§1): apply a nooq transaction. In signed mode the
   * document mutates synchronously (EB-6: typing never waits); the envelope
   * seals and ships a microtask later, so the wire always carries it.
   */
  apply(tx: Transaction): void {
    if (this.closed || this.runtime.busy || this.applying) throw new Error("Cannot mutate in this phase");
    // Legacy propose() may supply its explicitly configured AI key. New plugins use jobBindings.
    if (tx.actor.actorId !== this.localActor().actorId && !tx.adoptedBy && this.options.aiKey) {
      this.applyBound(tx, { ...this.identities.get("legacy-ai")!, actor: tx.actor });
    } else if (!isSecuredDocId(this.docId)) {
      const identity = this.identities.get("local")!;
      this.applyBound(tx, { ...identity, actor: { ...identity.actor, actorId: tx.adoptedBy ?? tx.actor.actorId } });
    } else this.applyBound(tx, this.identities.get("local")!);
  }

  private applyBound(tx: Transaction, identity: { actor: ActorDescriptor; key?: import("@nooq/core").ActorKey; publicKey?: string; ready: boolean }, genesis = false): void {
    if (this.closed || this.applying) throw new Error("Cannot mutate in this phase");
    if (!genesis) {
      const verdict = authorizeLocal(this.view, tx, { actorId: identity.actor.actorId, key: identity.publicKey, signingReady: identity.ready && !!identity.key });
      if (verdict.reason === "invalid-transaction") throw new Error("Invalid transaction");
      if (verdict.verdict !== "allow") throw new AuthorizationError(verdict.reason, verdict.verdict === "hold");
    }
    this.lamport = Math.max(this.lamport, tx.lamport);
    this.applying = true; this.currentTx = tx;
    try {
    if (identity.key) {
      // The signer is not always the author: adoptions are authored by the
      // proposing AI but signed by the accepting writer (DM-6.3, DM-13).
      const signer = tx.adoptedBy ?? tx.actor.actorId;
      const captured = applyCaptured(this.ydoc, tx, identity.key, signer);
      void this.ship(captured);
      return;
    }
    applyToDoc(this.ydoc, tx);
    } finally { this.currentTx = undefined; this.applying = false; }
  }

  private commitCommand(prepared: Extract<PreparedCommand, { status: "ready" }>, actor: ActorDescriptor): CommandResult {
    try {
      const tx = { ...this.tx([...prepared.ops], prepared.intent), actor };
      this.applyBound(tx, this.identities.get("local")!);
      if (prepared.selection) queueMicrotask(() => { if (!this.closed) for (const listener of this.selectionListeners) try { listener(prepared.selection!); } catch (cause) { this.reportError({ phase: "observer", cause }); } });
      return { status: "applied", transaction: tx, ...(prepared.selection ? { selection: prepared.selection } : {}) };
    } catch (error) {
      if (error instanceof AuthorizationError) return { status: "denied", reason: error.reason, retryable: error.retryable };
      throw error;
    }
  }
  private publishJob(id: string, proposal: Proposal, intent?: string): PublicationResult {
    const identity = this.identities.get(`job:${id}`)!;
    const block = makeSuggestionBlock(proposal, identity.actor.actorId);
    const tx = { ...this.tx([{ op: "insert", block, parent: null }], intent), actor: identity.actor };
    try { this.applyBound(tx, identity); return { status: "published", suggestion: block.id }; }
    catch (error) { if (error instanceof AuthorizationError) return { status: "denied", reason: error.reason, retryable: error.retryable }; throw error; }
  }

  private async ship(commit: { tx: Transaction; update: Uint8Array; key: import("@nooq/core").ActorKey; signer: string }): Promise<void> {
    try {
      const sealed = await sealEnvelope(this.ydoc, commit.tx, commit.update, commit.key, commit.signer);
      this.session?.sendUpdate(commit.update, sealed);
    } catch (cause) {
      this.reportError({ phase: "signing", cause });
    }
  }

  private tx(ops: Op[], intent?: string): Transaction {
    return {
      id: newBlockId(),
      actor: this.localActor(),
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

  /** The local actor's id (blocks the surface creates are attributed to it). */
  get actorId(): string {
    return this.options.actor.actorId;
  }

  /** Ops as ONE nooq transaction — structure keystrokes stay atomic (§1). */
  applyOps(ops: readonly import("@nooq/core").Op[], intent?: string): void {
    this.apply(this.tx([...ops], intent));
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

  /** Async identity verification is completed before the synchronous genesis commit. */
  async initializeAccess(access: import("@nooq/core").Access): Promise<void> {
    await this.ready;
    const identity = this.identities.get("local")!;
    const value = structuredClone(access);
    if (!isSecuredDocId(this.docId) || !await isGenesisFor(this.docId, value) || !identity.key
      || identity.publicKey !== value.owner.key || identity.actor.actorId !== value.owner.actorId || identity.actor.kind !== value.owner.kind) throw new Error("Invalid genesis identity");
    if (this.view.access || this.closed || this.runtime.busy) throw new Error("Genesis is no longer available");
    this.applyBound(this.tx([{ op: "setAccess", access: value }], "genesis"), identity, true);
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
  async reviewSuggestion(suggestion: BlockId): Promise<{ revision: number; proposal: string; evaluation: Evaluation }> {
    const state = this.view, revision = this.revision;
    return { revision, proposal: canonicalJson(state.blocks[suggestion]?.fields.proposal), evaluation: await evaluateSuggestion(state, suggestion) };
  }

  async accept(suggestion: BlockId, options: { force?: boolean; reviewed?: { revision: number; proposal: string }; signal?: AbortSignal } = {}): Promise<Transaction> {
    const reviewed = options.reviewed ?? { revision: this.revision, proposal: canonicalJson(this.view.blocks[suggestion]?.fields.proposal) };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed || options.signal?.aborted) throw new Error("Acceptance cancelled");
      const state = this.view, revision = this.revision, block = state.blocks[suggestion];
      if (!block || !liveTree(state).alive.has(suggestion) || block.fields.status !== undefined) throw new Error("Suggestion already settled");
      if (canonicalJson(block.fields.proposal) !== reviewed.proposal) throw new Error("Suggestion changed; review again");
      if (options.force && revision !== reviewed.revision) throw new Error("Force approval expired; review again");
      const evaluation = await evaluateSuggestion(state, suggestion);
      if (this.closed || options.signal?.aborted) throw new Error("Acceptance cancelled");
      if (this.revision !== revision) {
        if (options.force) throw new Error("Force approval expired; review again");
        continue;
      }
      if (!options.force && evaluation.status !== "fresh") throw new StaleSuggestionError(evaluation);
      const tx = acceptTransaction({ state, suggestion, actor: this.localActor(), lamport: ++this.lamport });
      this.apply(tx); // No await or plugin callback between revision check and commit.
      return tx;
    }
    throw new Error("changed-during-validation");
  }

  /** DM-6.4. */
  reject(suggestion: BlockId): void {
    const state = this.view;
    if (!liveTree(state).alive.has(suggestion) || state.blocks[suggestion]?.fields.status !== undefined) throw new Error("Suggestion already settled");
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

  /** SW-3: re-run the handshake over a new transport; unconfirmed envelopes resend (SW-4). */
  reconnect(transport: SyncTransport): void {
    if (!this.session) throw new Error("this editor was created without a transport");
    this.session.restart(transport);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.runtime.dispose();
    for (const listener of this.closeListeners) try { listener(); } catch (cause) { this.reportError({ phase: "cleanup", cause }); }
    this.closeListeners.clear(); this.selectionListeners.clear(); this.listeners.clear();
    this.session?.close();
    this.ydoc.destroy();
  }

  private localActor(): ActorDescriptor {
    return { actorId: this.options.actor.actorId, kind: this.options.actor.kind ?? "human", ...(this.options.actor.model ? { model: this.options.actor.model } : {}) };
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled || this.closed) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      if (this.closed) return;
      const batch = this.events.splice(0);
      for (const event of batch) this.runtime.emit(event);
      for (const callback of this.eventListeners) try { callback(batch); } catch (cause) { this.reportError({ phase: "observer", cause }); }
      for (const callback of this.listeners) try { callback(); } catch (cause) { this.reportError({ phase: "observer", cause }); }
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
