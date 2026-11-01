import { applyTransaction, canonicalJson, liveTree, makeBlock, tryValidateReadonly, validateTransaction } from "@nooq/core";
import type { ActorDescriptor, DocState, JsonValue, Transaction } from "@nooq/core";
import { createCommandPreparerOwned, freezeSnapshot, type ChangeEvent, type Command, type CommandResult, type Diagnostic, type Immutable, type PluginError, type PreparedCommand, type SelectionRequest } from "./definitions.ts";
import { ProposalCapture, UnsupportedEvidenceError, type Job, type JobHandle, type PublicationResult } from "./jobs.ts";
import { PluginRegistry } from "./registry.ts";
import { Scope } from "./scope.ts";

export interface RuntimeHost {
  /** The shared, frozen, read-only projection (cached by revision). */
  read(): DocState;
  /** A FRESH projection the caller may mutate or freeze (EB-6: ~30ms at 2,000 blocks — rationed). */
  readFresh(): DocState;
  actor: ActorDescriptor;
  commit(prepared: Extract<PreparedCommand, { status: "ready" }>, actor: ActorDescriptor): CommandResult;
  jobActor(id: string): ActorDescriptor | undefined;
  publish(job: string, proposal: import("@nooq/core").Proposal, intent?: string): PublicationResult;
  report(error: PluginError): void;
}

export class PluginRuntime {
  readonly #scopes: Scope[] = [];
  readonly #jobs = new Set<AbortController>();
  readonly #diagnostics = new Map<string, { signature: string; result: readonly Diagnostic[] }>();
  #busy = false;
  #closed = false;
  get busy(): boolean { return this.#busy; }
  get closed(): boolean { return this.#closed; }
  constructor(readonly registry: PluginRegistry, private readonly host: RuntimeHost) {}
  setup(): void {
    this.#busy = true;
    try {
      for (const plugin of this.registry.plugins) {
        const scope = new Scope(plugin.id, () => this.host.read(), error => this.host.report(error));
        this.#scopes.push(scope);
        try {
          const cleanup = plugin.setup?.(scope);
          if (cleanup && typeof cleanup !== "function") throw new Error(`Plugin ${plugin.id}: setup must be synchronous`);
          if (cleanup) scope.onCleanup(cleanup);
        } catch (cause) { this.host.report({ plugin: plugin.id, phase: "setup", cause }); throw cause; }
      }
    } catch (error) { this.dispose(); throw error; }
    finally { this.#busy = false; }
  }
  emit(event: ChangeEvent): void {
    this.#busy = true;
    try { for (const scope of this.#scopes) scope.emit(event); }
    finally { this.#busy = false; }
  }
  createBlock(type: string, actor = this.host.actor) {
    const entry = this.registry.block(type);
    if (!entry) throw new Error(`Unknown block type ${type}`);
    const defaults = entry.definition.create();
    return makeBlock({ type, fields: defaults.fields, ...(defaults.text ? { text: defaults.text } : {}) }, actor.actorId);
  }
  run<Args>(reference: Command<Args> | string, input: Args, options: { selection?: SelectionRequest; preview?: boolean } = {}): CommandResult | PreparedCommand {
    const id = typeof reference === "string" ? reference : reference.id, entry = this.registry.command(id);
    if (this.#closed || this.#busy) return { status: "failed", error: new Error(this.#closed ? "Editor is closed" : "Nested dispatch is forbidden") };
    this.#busy = true;
    try {
      if (!entry) throw new Error(`Unknown command ${id}`);
      const actor = { ...this.host.actor, plugin: entry.plugin };
      // EB-6/ref-large: the preparer's snapshot may be the host's SHARED
      // read-only projection (already frozen) — a fresh readState at 2,000
      // blocks costs ~30ms and bought nothing here.
      const result = createCommandPreparerOwned(this.host.read(), this.host.actor, this.registry)(id, input, options.selection); // shared frozen view: read-only by contract
      if (result.status === "not-applicable") return result;
      // Core-check previews too. Selection is a local request, validated before commit.
      // Validation mutates, so it gets a fresh throwaway read (EB-6: still no
      // clone; at 2,000 blocks a readState is ~30ms, so reads are rationed).
      if (options.preview || result.selection) {
        // EB-6 stage 2: the read-only fast path validates against the SHARED
        // view (free); only structural shapes pay a fresh ~30ms read.
        const shared = this.host.read();
        const preview = { id: "preview", actor, lamport: 0, causality: {}, ops: [...result.ops] } as import("@nooq/core").Transaction;
        if (!tryValidateReadonly(shared, preview, result.selection)) {
          const scratch = this.host.readFresh();
          validateTransaction(scratch, preview);
          if (result.selection) {
            const { block, anchor, head } = result.selection, length = scratch.blocks[block]?.text?.s.length ?? 0;
            if (!liveTree(scratch).alive.has(block) || ![anchor, head].every(n => Number.isInteger(n) && n >= 0 && n <= length)) throw new Error("Invalid selection request");
          }
        }
      }
      return options.preview ? result : this.host.commit(result, actor);
    } catch (error) {
      this.host.report({ plugin: entry?.plugin, phase: "command", cause: error });
      return { status: "failed", error };
    } finally { this.#busy = false; }
  }
  /** Prepare independent invocations of one selected command against one snapshot,
   * then authorize/commit their combined operations once. No partial success. */
  runBatch<Args>(reference: Command<Args> | string, inputs: readonly Args[]): CommandResult {
    const id = typeof reference === "string" ? reference : reference.id, entry = this.registry.command(id);
    if (this.#closed || this.#busy) return { status: "failed", error: new Error(this.#closed ? "Editor is closed" : "Nested dispatch is forbidden") };
    this.#busy = true;
    try {
      if (!entry) throw new Error(`Unknown command ${id}`);
      if (!Array.isArray(inputs)) throw new Error("Batch arguments must be an array");
      if (!inputs.length) return { status: "not-applicable" };
      const actor = { ...this.host.actor, plugin: entry.plugin };
      const prepare = createCommandPreparerOwned(this.host.read(), this.host.actor, this.registry);
      const combined: Extract<PreparedCommand, { status: "ready" }> = { status: "ready", intent: `batch:${id}`, ops: [] };
      const ops: import("@nooq/core").Op[] = [];
      for (const args of freezeSnapshot(inputs)) {
        const prepared = prepare(id, args);
        if (prepared.status === "not-applicable") return prepared;
        ops.push(...prepared.ops);
        if (prepared.selection) combined.selection = prepared.selection;
      }
      combined.ops = ops;
      // Validate the complete batch and its selection before the authorization boundary.
      // EB-6: fresh and mutable — the shared view is frozen.
      // EB-6 stage 2: read-only fast path first; fresh only for structural shapes.
      const shared = this.host.read();
      const preview = { id: "batch-preview", actor, lamport: 0, causality: {}, ops } as import("@nooq/core").Transaction;
      if (!tryValidateReadonly(shared, preview, combined.selection)) {
        const scratch = this.host.readFresh();
        validateTransaction(scratch, preview);
        if (combined.selection) {
          const { block, anchor, head } = combined.selection, length = scratch.blocks[block]?.text?.s.length ?? 0;
          if (!liveTree(scratch).alive.has(block) || ![anchor, head].every(n => Number.isInteger(n) && n >= 0 && n <= length)) throw new Error("Invalid selection request");
        }
      }
      return this.host.commit(combined, actor);
    } catch (error) {
      this.host.report({ plugin: entry?.plugin, phase: "command", cause: error });
      return { status: "failed", error };
    } finally { this.#busy = false; }
  }
  diagnose(id: string): readonly Diagnostic[] {
    const block = this.host.read().blocks[id];
    if (!block) return [];
    const entry = this.registry.block(block.type);
    if (!entry) return [];
    const signature = canonicalJson(block), cached = this.#diagnostics.get(id);
    if (cached?.signature === signature) return cached.result;
    try {
      const result = freezeSnapshot([...entry.definition.diagnose(freezeSnapshot(block))]);
      this.#diagnostics.set(id, { signature, result });
      return result;
    } catch (cause) { this.host.report({ plugin: entry.plugin, phase: "observer", cause }); return [{ message: "Plugin diagnostics failed" }]; }
  }
  start<Args, Result>(reference: Job<Args, Result> | string, input: Args): JobHandle<Result> {
    const id = typeof reference === "string" ? reference : reference.id, entry = this.registry.job(id);
    if (!entry) throw new Error(`Unknown job ${id}`);
    if (this.#closed || this.#busy) throw new Error("Cannot start a job in this phase");
    const args = freezeSnapshot(input);
    if (entry.definition.validateArgs(args) !== true) throw new Error(`Invalid job arguments: ${id}`);
    const abort = new AbortController(), captures = new WeakSet<ProposalCapture>();
    let finished = false;
    const listeners = new Set<(value: Immutable<JsonValue>) => void>();
    const actor = this.host.jobActor(id);
    if (entry.definition.publishes && !actor) throw new Error(`Publishing job ${id} has no host identity`);
    this.#jobs.add(abort);
    const cancelled = () => finished || abort.signal.aborted || this.#closed;
    const execution = Promise.resolve().then(() => {
      if (cancelled()) throw new DOMException("Job cancelled", "AbortError");
      return entry.definition.run({ signal: abort.signal,
        capture: () => { if (cancelled()) throw new DOMException("Job cancelled", "AbortError"); const base = new ProposalCapture(this.host.read()); captures.add(base); return base; },
        createBlock: type => this.createBlock(type, actor ?? this.host.actor),
        progress: value => { if (!cancelled()) for (const listener of [...listeners]) try { listener(freezeSnapshot(value)); } catch (cause) { this.host.report({ plugin: entry.plugin, phase: "observer", cause }); } },
        publish: async (base, output) => {
          if (cancelled()) return { status: "cancelled" };
          if (!actor || !entry.definition.publishes || !captures.has(base)) throw new Error("Publication requires this job's capture and host identity");
          try {
            const proposal = await base.proposal(output.ops, actor, output.context);
            if (cancelled()) return { status: "cancelled" };
            return this.host.publish(id, proposal, output.intent);
          } catch (error) {
            if (error instanceof UnsupportedEvidenceError) return { status: "unsupported-evidence", reason: error.message };
            throw error;
          }
        },
      }, args);
    });
    const cancellation = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new DOMException("Job cancelled", "AbortError")), { once: true }));
    const result = Promise.race([execution, cancellation]).then(value => {
      if (cancelled()) throw new DOMException("Job cancelled", "AbortError");
      return value as Result;
    }).finally(() => { finished = true; this.#jobs.delete(abort); listeners.clear(); });
    void result.catch(cause => { if (!abort.signal.aborted && !this.#closed) this.host.report({ plugin: entry.plugin, phase: "job", cause }); });
    return { result, signal: abort.signal, cancel: () => abort.abort(), onProgress(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of this.#jobs) job.abort();
    this.#jobs.clear();
    for (const scope of this.#scopes.splice(0).reverse()) scope.dispose();
    this.#diagnostics.clear();
  }
}
