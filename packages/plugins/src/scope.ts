import { freezeSnapshot, type ChangeEvent, type PluginError, type PluginScope } from "./definitions.ts";
import type { DocState } from "@nooq/core";

export class Scope implements PluginScope {
  readonly #abort = new AbortController();
  readonly state = new Map<unknown, unknown>();
  readonly #cleanups: (() => void)[] = [];
  readonly #listeners = new Set<(event: ChangeEvent) => void>();
  get signal(): AbortSignal { return this.#abort.signal; }
  constructor(readonly plugin: string, private readonly read: () => DocState, private readonly report: (error: PluginError) => void) {}
  snapshot() { return freezeSnapshot(this.read()); }
  onCleanup(cleanup: () => void): void {
    if (this.signal.aborted) this.clean(cleanup); else this.#cleanups.push(cleanup);
  }
  onChange(listener: (event: ChangeEvent) => void): () => void {
    if (this.signal.aborted) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  select<T>(selector: (state: ReturnType<Scope["snapshot"]>) => T, listener: (value: T) => void, equal: (a: T, b: T) => boolean = Object.is): () => void {
    let current = selector(this.snapshot());
    return this.onChange(() => { const next = selector(this.snapshot()); if (!equal(current, next)) { current = next; listener(next); } });
  }
  emit(event: ChangeEvent): void {
    if (this.signal.aborted) return;
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch (cause) { this.report({ plugin: this.plugin, phase: "observer", cause }); }
    }
  }
  private clean(cleanup: () => void) { try { cleanup(); } catch (cause) { this.report({ plugin: this.plugin, phase: "cleanup", cause }); } }
  dispose(): void {
    if (this.signal.aborted) return;
    this.#abort.abort(); this.#listeners.clear();
    for (const cleanup of this.#cleanups.splice(0).reverse()) this.clean(cleanup);
    this.state.clear();
  }
}
