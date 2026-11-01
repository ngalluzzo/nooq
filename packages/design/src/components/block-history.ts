/**
 * Block history (0005, DM-14.4): what the interactive change bar opens. One
 * row per transaction, newest first — the writer as an ActorChip, the DM-4
 * intent as written, and the lamport EXACT in the digest face. A machine's
 * number is never translated: "lamport 42", never "a moment ago".
 */
import type { ActorKind } from "@nooq/core";
import { el } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { PeerInk } from "../peer.ts";
import { actorChip } from "./actor-chip.ts";
import { button } from "./button.ts";

export interface BlockHistoryEntry {
  /** The writer as they should read: a person's name, the model for AI (DM-5). */
  writer: string;
  /** DM-5 actor kind, so machine writers read as words (AI, Importer…); humans show only their name. */
  kind?: ActorKind;
  /** The writer's derived peer ink; pass it for remote humans. The local writer stays ink. */
  ink?: PeerInk;
  /** DM-4 intent, as written (for example `rewrite-intro`); absent when the transaction had none. */
  intent?: string;
  /** DM-2 lamport clock. Rendered exactly, in the digest face. */
  lamport: number;
}

export interface BlockHistoryPanelProps {
  entries: readonly BlockHistoryEntry[];
  /** The deleted flow: restores the block. Absent on a live block's history. */
  onRestore?: () => void;
}

/**
 * The panel behind the interactive change bar. Rows are shown newest first
 * (highest lamport; equal lamports keep the caller's order) with exactly one
 * row per entry — the caller decides what a transaction is, never the panel.
 * Usage: mount it in a `popover()` anchored to the bar; the editor surface
 * does this through `onHistory`. Not for live, not-yet-committed drafts —
 * history is the recorded past.
 */
export function blockHistoryPanel({ entries, onRestore }: BlockHistoryPanelProps): HTMLUListElement {
  const rows = [...entries]
    .sort((a, b) => b.lamport - a.lamport)
    .map((entry) =>
      el(
        "li",
        { class: "nq-history-row" },
        actorChip({ name: entry.writer, ...(entry.kind !== undefined ? { kind: entry.kind } : {}), ...(entry.ink !== undefined ? { ink: entry.ink } : {}) }),
        entry.intent !== undefined && el("span", { class: "nq-history-intent nq-ui-caption" }, entry.intent),
        el("span", { class: "nq-history-lamport nq-digest" }, `lamport ${entry.lamport}`),
      ),
    );
  if (onRestore !== undefined) {
    rows.push(
      el("li", { class: "nq-history-restore" }, button({ label: [glyph("undo"), "Restore"], variant: "quiet", onClick: onRestore })),
    );
  }
  return el("ul", { class: "nq-history", "aria-label": "Block history" }, rows);
}
