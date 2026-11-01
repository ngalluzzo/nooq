/**
 * Maintained projection — the incremental DocState (EB-6 stage 2).
 *
 * readState() rebuilds the whole projection from Yjs on every call; at
 * 2,000 blocks that is ~30ms, and the keystroke path paid several per
 * key (the EB-6 Draft 2 finding). The MaintainedProjection instead keeps
 * one DocState current by applying Yjs transaction events — the same
 * authority readState reads (the placement register, DM-3) — and serves
 * it read-only and frozen. It must agree with readState BY CONSTRUCTION;
 * packages/yjs/test/projection.test.ts enforces canonical equality after
 * every operation kind and seeded op storms, local and remote.
 */

import * as Y from "yjs";
import type { Block, BlockId, DocState, JsonValue, RenderedText } from "@nooq/core";
import { REGISTER, documentHeader, layout, type Placement } from "./layout.ts";
import { readBlock, readState } from "./read.ts";

function isRegister(raw: unknown): raw is Placement {
  return typeof raw === "object" && raw !== null && (raw as { nooq?: unknown }).nooq === REGISTER;
}

export class MaintainedProjection {
  #doc: Y.Doc;
  #state: DocState;
  /** register.agreement: id -> container (null root), tombstones excluded. */
  #containerOf = new Map<BlockId, BlockId | null>();
  /** Physical children arrays by container, unfiltered. */
  #physical = new Map<BlockId | null, BlockId[]>();
  #dirty = false;
  #offs: Array<() => void> = [];

  constructor(doc: Y.Doc) {
    this.#doc = doc;
    this.#state = readState(doc); // seed from the pure projection
    this.#index();
    const { blocks: yblocks, roots: yroots, placement, access: yaccess } = layout(doc);

    const deep = (events: Y.YEvent<never>[]): void => {
      // Coalesce rebuilds per block. EB-8: a huge fan-out (initial sync of a
      // 10k-block document fires one event per block) rebuilds cheaper as ONE
      // bulk re-seed from readState than as N incremental readBlocks.
      const rebuild = new Set<string>();
      const drop = new Set<string>();
      for (const event of events) {
        const path = event.path;
        if (path.length === 0 && event instanceof Y.YMapEvent) {
          for (const [id, change] of event.keys) {
            if (change.action !== "delete") rebuild.add(String(id));
            else drop.add(String(id));
          }
        } else if (path.length >= 1) {
          rebuild.add(String(path[0]));
        }
      }
      if (rebuild.size + drop.size > 200) { this.#reseed(); this.#dirty = true; return; }
      for (const id of drop) this.#dropBlock(id);
      for (const id of rebuild) if (!drop.has(id)) this.#rebuildBlock(id);
      this.#dirty = true;
    };
    const deepHandler = deep as never;
    yblocks.observeDeep(deepHandler);
    const placementHandler = (event: Y.YMapEvent<Placement>): void => {
      // Coalesce: one event may carry thousands of keys (initial sync);
      // recompute each AFFECTED container once, not once per key (EB-6).
      const touchedContainers = new Set<BlockId | null>();
      for (const [id, change] of event.keys) {
        const previous = change.oldValue as Placement | undefined;
        if (previous && !previous.tombstoned) { this.#containerOf.delete(id); this.#indexMembership(id, previous.parent, true); touchedContainers.add(previous.parent); }
        const entry = placement.get(id);
        if (entry && !entry.tombstoned) { this.#containerOf.set(id, entry.parent); this.#indexMembership(id, entry.parent); touchedContainers.add(entry.parent); }
      }
      for (const container of touchedContainers) this.#recomputeChildren(container);
      this.#dirty = true;
    };
    placement.observe(placementHandler);
    const rootsHandler = (): void => {
      this.#physical.set(null, yroots.toArray());
      this.#dirty = true;
    };
    yroots.observe(rootsHandler);
    const accessHandler = (): void => {
      const entry = yaccess.get("access");
      if (entry === undefined) delete this.#state.access;
      else this.#state.access = structuredClone(entry) as DocState["access"];
      this.#dirty = true;
    };
    yaccess.observe(accessHandler);
    this.#offs = [
      () => yblocks.unobserveDeep(deepHandler),
      () => placement.unobserve(placementHandler),
      () => yroots.unobserve(rootsHandler),
      () => yaccess.unobserve(accessHandler),
    ];
  }

  destroy(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  /** The maintained state, frozen read-only (the shared `view` contract). */
  get value(): DocState {
    return this.#state;
  }

  /** Heal + canonical roots/children recomputation; call before serving. */
  sync(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#state.roots = this.#childrenOf(null);
  }

  // --- indexing -----------------------------------------------------------

  /** Rebuild everything from the pure projection (bulk fan-outs, EB-8). */
  #reseed(): void {
    this.#state = readState(this.#doc);
    this.#index();
  }

  #index(): void {
    // EB-8: ONLY the register index is eager (10k map reads). Physical
    // arrays materialize lazily per touched container — eager toArray of
    // every block's children was 10k allocations inside the load path.
    const { blocks: yblocks, placement } = layout(this.#doc);
    this.#containerOf.clear();
    this.#physical.clear();
    this.#byContainer.clear();
    for (const id of yblocks.keys()) {
      const entry = placement.get(id);
      if (entry && !entry.tombstoned) { this.#containerOf.set(id, entry.parent); this.#indexMembership(id, entry.parent); }
    }
  }

  #rebuildBlock(id: string): void {
    const { blocks: yblocks, placement } = layout(this.#doc);
    const yb = yblocks.get(id) as Y.Map<unknown> | undefined;
    if (!yb) { this.#dropBlock(id); return; }
    const children = yb.get("children") as Y.Array<BlockId> | undefined;
    if (children) this.#physical.set(id, children.toArray());
    this.#state.blocks[id] = readBlock(id, yb, container => this.#childrenOf(container));
    void placement;
  }

  #dropBlock(id: string): void {
    delete this.#state.blocks[id];
    this.#physical.delete(id);
    const container = this.#containerOf.get(id);
    if (container !== undefined) this.#indexMembership(id, container, true);
    this.#containerOf.delete(id);
  }

  #indexMembership(id: BlockId, container: BlockId | null, remove = false): void {
    let set = this.#byContainer.get(container);
    if (!set && !remove) { set = new Set(); this.#byContainer.set(container, set); }
    if (remove) set?.delete(id);
    else set!.add(id);
  }

  #recomputeChildren(container: BlockId | null): void {
    const { blocks: yblocks, roots: yroots } = layout(this.#doc);
    if (container === null) this.#physical.set(null, yroots.toArray());
    else {
      const children = (yblocks.get(container)?.get("children") as Y.Array<BlockId> | undefined) ?? undefined;
      if (children) this.#physical.set(container, children.toArray());
    }
    const block = container === null ? undefined : this.#state.blocks[container];
    if (container !== null && block) block.children = this.#childrenOf(container);
    if (container === null) this.#state.roots = this.#childrenOf(null);
  }

  /** Register-authority membership by container (the heal index, EB-6). */
  #byContainer = new Map<BlockId | null, Set<BlockId>>();

  #childrenOf(container: BlockId | null): BlockId[] {
    if (!this.#physical.has(container)) {
      const { blocks: yblocks, roots: yroots } = layout(this.#doc);
      this.#physical.set(container, container === null ? yroots.toArray()
        : ((yblocks.get(container)?.get("children") as Y.Array<BlockId> | undefined)?.toArray() ?? []));
    }
    const physical = this.#physical.get(container) ?? [];
    const out: BlockId[] = [];
    const seen = new Set<BlockId>();
    for (const id of physical) {
      if (this.#containerOf.get(id) !== container) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    // Heal (DM-3 register authority): members registered to this container
    // but absent from the physical array — O(members), not O(document).
    const missing: BlockId[] = [];
    for (const id of this.#byContainer.get(container) ?? []) {
      if (!seen.has(id) && this.#state.blocks[id]) missing.push(id);
    }
    missing.sort();
    out.push(...missing);
    return out;
  }
}

