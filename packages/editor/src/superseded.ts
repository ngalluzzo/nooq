/**
 * Superseded-move detection (DM-4.9, proposal 0010) — the editor half of
 * "your move lost a concurrent race and the register kept someone else's".
 *
 * DETECT — for each incoming REMOTE transaction writing a block's placement
 * (a `move`, or the `delete` whose tombstone can win one), find this
 * writer's prior local move M on the same block. The incoming write raced M
 * when its causality vector does not include M —
 * `incoming.causality[actor] < M.lamport` (DM-2; absence is concurrency). A
 * move made after observing M is a later edit, never supersession. After
 * the transaction merges, the register's surviving write says who won:
 *
 * - surviving write is the local writer's → the INCOMING write lost, and
 *   that is not ours to report (silence);
 * - surviving write is a tombstone → the move raced a delete: report it as
 *   deletion (DM-4.8 wording applies, DM-4.9);
 * - surviving parent differs from M's destination → supersession: report
 *   it, naming the winning actor;
 * - same parent → agreement, not loss (silence). The register is parent
 *   authority; sibling order is the children array's, resolved like
 *   DM-4.8's order rules, so only the parent is compared.
 *
 * A losing move reports once, then retires: history keeps both
 * transactions and tells this story a single time.
 *
 * FEED — the same remote happenings the surface consumes, delivered as
 * whole transactions: `editor.onRemoteTransaction` fires with ops and
 * causality after the update merged (ChangeEvent.transaction is the exact
 * LOCAL transaction by contract, and remote transactions are only known
 * with their envelope, after the update applied — see controller.ts).
 * Transactions that arrive without envelopes (bare updates in open
 * documents) carry no history here, so they carry no detection: the
 * detector sees what the history store sees (DM-14.4).
 *
 * PLACEMENT READ — `layout(editor.ydoc).placement` is the cleanest public
 * seam for the surviving write: the register IS the adapter's authority
 * (DM-4.7), `layout()` is already the exported public mapping the surface
 * reads, and `editor.view` (DocState) projects parents/children but
 * discards the winning write's actor and lamport — exactly what detection
 * needs. No adapter change.
 *
 * ARM — the away-tracker precedent: opening a document replays history
 * (bootstrap envelopes fire this feed for every logged transaction), and
 * none of it was raced here. The surface arms detection with its first
 * content render; before that, nothing fires.
 *
 * `force` is the test/story seam — a true race cannot be timed honestly in
 * a mounted harness, so tests and stories force the event through the same
 * emission path the detector's honest feed reaches.
 */
import type { BlockId, Transaction } from "@nooq/core";
import { layout } from "@nooq/yjs";
import type { Editor } from "./controller.ts";

/** A local move that lost a concurrent placement race (DM-4.9). */
export interface SupersededEvent {
  block: BlockId;
  /** The losing local move, full provenance intact (it stays in history). */
  losing: Transaction;
  /** The surviving placement write's actor — the delete's author when `deleted`. */
  winningActor: string;
  /** The register kept a tombstone: deletion wording (DM-4.8), no reassertion. */
  deleted: boolean;
}

export interface SupersededDetector {
  /** Supersession events, in detection order; emits only while armed. */
  onEvent(listener: (event: SupersededEvent) => void): () => void;
  /**
   * Arms detection with the surface's first settled state. Before arming,
   * the feed fires for nothing — replayed history was never raced here.
   */
  arm(): void;
  /** Session end: drop listeners and go quiet. */
  destroy(): void;
  /** Test/story seam: force the event the honest path needs a true race for. */
  force(event: SupersededEvent): void;
  isArmed(): boolean;
}

export function createSupersededDetector(editor: Editor): SupersededDetector {
  const listeners = new Set<(event: SupersededEvent) => void>();
  /** Remote transaction ids already examined (the feed may repeat: bootstrap log, rebroadcast). */
  const examined = new Set<string>();
  /** Local moves already reported — a losing move tells its story once. */
  const reported = new Set<string>();
  let armed = false;
  let destroyed = false;

  const emit = (event: SupersededEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const handle = (tx: Transaction): void => {
    if (destroyed || !armed) return;
    if (tx.actor.actorId === editor.actorId || examined.has(tx.id)) return; // own envelope's echo, or a repeat
    examined.add(tx.id);
    for (const op of tx.ops) {
      // Only ops that write this block's placement register can supersede a move.
      if (op.op !== "move" && op.op !== "delete") continue;
      const block: BlockId = op.block;
      // The prior local move this incoming write may have raced: the latest
      // local move on this block whose lamport the incoming causality does
      // not cover. A vector that includes it means the remote author had
      // seen it — a later edit, not a race (DM-4.9).
      let losing: Transaction | undefined;
      let destination: BlockId | null | undefined;
      for (const candidate of editor.history()) {
        if (candidate.actor.actorId !== editor.actorId || reported.has(candidate.id)) continue;
        if (!((tx.causality[editor.actorId] ?? 0) < candidate.lamport)) continue;
        const move = candidate.ops.find((m): m is Extract<typeof m, { op: "move" }> => m.op === "move" && m.block === block);
        if (!move) continue;
        if (losing === undefined || losing.lamport < candidate.lamport) { losing = candidate; destination = move.newParent; }
      }
      if (losing === undefined || destination === undefined) continue; // their move just arrived, or a later edit
      const surviving = layout(editor.ydoc).placement.get(block);
      if (surviving === undefined) continue;
      if (surviving.actor === editor.actorId) continue; // a local write stands: the incoming write lost, not ours to report
      reported.add(losing.id);
      if (surviving.tombstoned) emit({ block, losing, winningActor: surviving.actor, deleted: true });
      else if (surviving.parent !== destination) emit({ block, losing, winningActor: surviving.actor, deleted: false });
      // Same parent: agreement, not loss — no supersession occurred.
    }
  };

  const off = editor.onRemoteTransaction(handle);
  return {
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    arm() { armed = true; },
    destroy() { destroyed = true; listeners.clear(); off(); },
    force(event) { if (!destroyed) emit(event); },
    isArmed: () => armed,
  };
}
