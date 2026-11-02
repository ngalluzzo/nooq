/**
 * Away markers (foundation P1 "Away markers and lost moves" — the away half;
 * the lost-move notice stays parked until DM-10 resolves what a lost move
 * observably is).
 *
 * A mark says: while this block was outside your window, someone changed it.
 *
 * DETECT — a remote ChangeEvent naming a block the surface does not have
 * mounted marks it. The rows map is the truth (EB-8): windowed-out is
 * absent, and absence at the moment the event lands is what detection reads.
 * Remote changes to mounted (visible) blocks never mark — the writer watched
 * them happen. Local changes never mark. Detection arms with the surface's
 * first content render (`arm`): before any row mounts there is no window to
 * be out of, so a remote bootstrap names every block and marks none — the
 * open state is not away.
 *
 * CLEAR — exactly three triggers, all wired by the surface: focus moves into
 * the block's row (`clear`, from focusin resolution), a local edit to the
 * block (the local half of `observe` — the writer just wrote it), and the
 * block's history opening (`clear`, from the surface's nq:block-history
 * listener). Rendering, scrolling, mounting and time never clear.
 *
 * LIFETIME — session-local. Deletion is the only other way a mark leaves
 * early: `prune` drops every marked id absent from the live tree. `destroy`
 * — with the surface — drops everything. Nothing persists.
 *
 * The core is layout-free by design: every decision above is unit-testable
 * against a fake `mountedIds`, and the surface owns every DOM consequence
 * (the row shell's data-nq-away attribute and the .nq-sr word inside it).
 * `force` is the test/story seam — windowing cannot be simulated honestly
 * in a harness, so tests mount normally and force the mark through it.
 */
import type { ChangeEvent } from "@nooq/plugins";

export interface AwayOptions {
  /** The mounted block ids — the surface's rows map. A windowed-out block is absent, and that absence is the truth detection reads, at event time. */
  mountedIds(): Iterable<string>;
  /** Fires whenever a block's mark appears or disappears; the surface re-syncs that block's row shell if it has one. */
  onFlip?(block: string): void;
}

export interface AwayTracker {
  /**
   * The change feed (the surface's pendingBatch accumulation). A remote
   * event marks every named block that is not mounted at event time; a
   * local event clears the blocks it names — the writer's own edit is a
   * visit.
   */
  observe(event: ChangeEvent): void;
  /**
   * Detection arms with the surface's first content render. Before any row
   * mounts there is no window to be out of — the open state is not away —
   * so a remote bootstrap (which names every block in the document) marks
   * nothing. Local edits are unaffected (there is nothing to clear yet).
   */
  arm(): void;
  /** Focus entered the block's row, or its history opened. Returns whether a mark was there to clear. */
  clear(block: string): boolean;
  /** Deleted blocks lose their marks: drop every marked id absent from the live tree. */
  prune(alive: ReadonlySet<string>): void;
  /** Test/story seam: force the mark the honest path needs a windowed-out block for. Bypasses the arm gate by design. */
  force(block: string): void;
  isMarked(block: string): boolean;
  /** The marked block ids (test/story inspection). */
  markedIds(): ReadonlySet<string>;
  /** Session end: drop everything, quietly — the rows are going too. */
  destroy(): void;
}

export function createAwayTracker({ mountedIds, onFlip }: AwayOptions): AwayTracker {
  const marked = new Set<string>();
  let destroyed = false;
  let armed = false;
  /** Flip only when isMarked actually changes: marks never churn themselves. */
  const flip = (block: string, now: boolean): void => {
    const was = marked.has(block);
    if (now) marked.add(block);
    else marked.delete(block);
    if (was !== now) onFlip?.(block);
  };
  return {
    observe(event) {
      if (destroyed) return;
      if (event.origin === "remote") {
        if (!armed) return; // the open state is not away: no window exists to have missed anything
        // Mounted truth is read when the event lands, before the render
        // applies it — a change the writer could not have seen marks.
        let mounted: Set<string> | undefined; // built once per event, only when a candidate needs it
        for (const block of event.blocks) {
          if (marked.has(block)) continue; // already away; marks do not refresh
          mounted ??= new Set(mountedIds());
          if (!mounted.has(block)) flip(block, true);
        }
        return;
      }
      // A local edit to the block is the writer's own visit: clear, never mark.
      for (const block of event.blocks) if (marked.has(block)) flip(block, false);
    },
    arm() { armed = true; },
    clear(block) {
      if (destroyed || !marked.has(block)) return false;
      flip(block, false);
      return true;
    },
    prune(alive) {
      if (destroyed) return;
      for (const block of [...marked]) if (!alive.has(block)) flip(block, false);
    },
    force(block) {
      if (destroyed || marked.has(block)) return;
      flip(block, true);
    },
    isMarked: block => marked.has(block),
    markedIds: () => marked,
    destroy() {
      destroyed = true;
      marked.clear(); // no flips to report: the surface owns these rows and is removing them
    },
  };
}
