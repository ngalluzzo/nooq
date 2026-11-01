/**
 * Block history on the surface (0005, DM-14.4): the popover behind the
 * interactive change bar, and the deleted layer under the live document.
 *
 * A view opts its bar in with blockRow's `onHistory`. The host — this module,
 * wired by the surface — owns what the plugin cannot see: the history store,
 * the awareness names and the presence inks. The reference contract between
 * them is one bubbling `nq:block-history` DOM event dispatched from the bar;
 * every block, built-in or third-party, gets the same wiring (§7).
 */
import { liveTree, type ActorKind, type ActorDescriptor, type BlockId, type Op, type Transaction } from "@nooq/core";
import { blockHistoryPanel, blockRow, peerInk, popover, type BlockKind, type PeerInk, type PopoverHandle } from "@nooq/design";
import type { Editor } from "./controller.ts";
import type { Presence } from "./presence.ts";

/** An op touches a block when it names it: as its target, or as the container something landed in. */
export function opTouchesBlock(op: Op, block: BlockId): boolean {
  switch (op.op) {
    case "insert": return op.block.id === block || op.parent === block;
    case "move": return op.block === block || op.newParent === block;
    case "restore": return op.block === block || op.parent === block;
    case "setField":
    case "textEdit":
    case "delete": return op.block === block;
    default: return false; // setAccess touches the document, never a block
  }
}

/** Every recorded transaction whose ops touch the block, in arrival order — one row per transaction, no dedupe. */
export function transactionsTouching(editor: Editor, block: BlockId): readonly Transaction[] {
  return editor.history().filter(tx => tx.ops.some(op => opTouchesBlock(op, block)));
}

/** DM-5 in words: the model for an AI actor, the awareness name for a present peer, the actor id otherwise. */
function writerOf(editor: Editor, actor: ActorDescriptor): string {
  if (actor.kind === "ai") return actor.model ?? actor.actorId;
  return editor.awareness.get(actor.actorId)?.name ?? actor.actorId;
}

/** A remote human's derived ink, waiting for the hash when it has not resolved yet. */
async function inkOf(editor: Editor, actor: ActorDescriptor, presence?: Presence): Promise<PeerInk | undefined> {
  if (actor.kind !== "human" || actor.actorId === editor.actorId) return undefined; // the local writer stays ink
  return presence?.inkOf(actor.actorId) ?? peerInk(actor.actorId);
}

export interface BlockHistoryRow { writer: string; kind?: ActorKind; ink?: PeerInk; intent?: string; lamport: number }

/** The panel rows for one block: touching transactions, newest first. */
export async function blockHistoryRows(editor: Editor, block: BlockId, presence?: Presence): Promise<BlockHistoryRow[]> {
  const rows: BlockHistoryRow[] = [];
  for (const tx of transactionsTouching(editor, block)) {
    const ink = await inkOf(editor, tx.actor, presence);
    rows.push({
      writer: writerOf(editor, tx.actor),
      kind: tx.actor.kind, // DM-5: machine writers read as words (AI, Importer…)
      ...(ink !== undefined ? { ink } : {}),
      ...(tx.intent !== undefined ? { intent: tx.intent } : {}),
      lamport: tx.lamport,
    });
  }
  return rows;
}

/**
 * Open the block's history: the design popover anchored to the bar, holding
 * the panel. Escape dismisses and returns focus to the anchor (the popover's
 * contract). Async because a remote writer's ink is a hash that may still be
 * resolving — the panel never shows a peer in a borrowed color.
 */
export async function openBlockHistory(editor: Editor, anchor: HTMLElement, block: BlockId, presence?: Presence): Promise<PopoverHandle> {
  const handle = popover({ anchor, side: "bottom", content: blockHistoryPanel({ entries: await blockHistoryRows(editor, block, presence) }) });
  document.body.append(handle.element);
  return handle;
}

/** The block's last-known parent from history, if that parent is still alive; roots restore as roots. */
export function restoreParentOf(editor: Editor, block: BlockId): BlockId | null {
  const txs = editor.history();
  for (let i = txs.length - 1; i >= 0; i--) {
    const ops = txs[i]!.ops;
    for (let j = ops.length - 1; j >= 0; j--) {
      const op = ops[j]!;
      const parent = op.op === "insert" && op.block.id === block ? op.parent
        : op.op === "move" && op.block === block ? op.newParent
        : op.op === "restore" && op.block === block ? op.parent
        : undefined;
      if (parent === undefined) continue;
      return parent !== null && liveTree(editor.view).alive.has(parent) ? parent : null;
    }
  }
  return null;
}

/**
 * DM-4.8: how many transactions after the delete touched the block — the
 * later edits that come back with a restore. Zero when the delete is the
 * newest thing on record (or the block was never deleted).
 */
export function laterEditsOf(editor: Editor, block: BlockId): number {
  const touching = transactionsTouching(editor, block);
  for (let i = touching.length - 1; i >= 0; i--) {
    if (touching[i]!.ops.some(op => op.op === "delete" && op.block === block)) return touching.length - 1 - i;
  }
  return 0;
}

/** A view may keep rendering its own tombstones in the history layer (the settled suggestion card). */
export function viewKeepsHistory(view: { mount: unknown } | undefined): boolean {
  return !!view && (view as { rendersHistory?: boolean }).rendersHistory === true;
}

const KINDS: Record<string, BlockKind> = { "nooq.paragraph/v1": "paragraph", "nooq.heading/v1": "heading", "nooq.quote/v1": "quote" };

interface DeletedRow {
  id: BlockId;
  content: string;
  kind: BlockKind;
  actor: ActorKind;
  writer?: string;
  ink?: PeerInk;
  laterEdits: number;
}

function deletedRow(editor: Editor, block: BlockId, presence?: Presence): DeletedRow | undefined {
  const record = editor.view.blocks[block];
  if (!record) return undefined;
  const last = transactionsTouching(editor, block).at(-1);
  const actor = last?.actor.kind ?? "human";
  // An unresolved remote ink stays unset for a frame rather than borrow the
  // local writer's; presence resolution re-renders the layer with the color.
  const ink = last && actor === "human" && last.actor.actorId !== editor.actorId ? presence?.inkOf(last.actor.actorId) : undefined;
  return {
    id: block,
    content: record.text?.s || record.type,
    kind: KINDS[record.type] ?? "paragraph",
    actor,
    ...(last ? { writer: writerOf(editor, last.actor) } : {}),
    ...(ink !== undefined ? { ink } : {}),
    laterEdits: laterEditsOf(editor, block),
  };
}

export interface HistoryLayer {
  /** The surface calls this on structural renders with the tombstoned ids to show. */
  update(ids: readonly BlockId[]): void;
  destroy(): void;
}

/**
 * The deleted layer: tombstoned blocks as BlockRow's deleted variant — the
 * block struck through, "Deleted with N later edits", Restore via
 * editor.restoreBlock under the block's last-known parent (DM-3.4, DM-4.8).
 * This is the flow the generic fallback used to draw, and could not.
 */
export function createHistoryLayer(editor: Editor, host: HTMLElement, presence?: Presence): HistoryLayer {
  host.classList.add("nq-history-layer");
  let signature = "";
  return {
    update(ids: readonly BlockId[]): void {
      const rows = ids.flatMap(id => {
        const row = deletedRow(editor, id, presence);
        return row ? [row] : [];
      });
      const next = JSON.stringify(rows);
      if (next === signature) return; // structural renders are rare; redraw only on change
      signature = next;
      host.replaceChildren(...rows.map(row => blockRow({
        content: row.content,
        kind: row.kind,
        actor: row.actor,
        ...(row.writer !== undefined ? { writer: row.writer } : {}),
        ...(row.ink !== undefined ? { ink: row.ink } : {}),
        deleted: true,
        laterEdits: row.laterEdits,
        onRestore: () => {
          try { editor.restoreBlock(row.id, restoreParentOf(editor, row.id)); }
          catch (cause) { editor.reportError({ phase: "view", cause }); }
        },
      })));
    },
    destroy(): void {
      signature = "";
      host.replaceChildren();
    },
  };
}
