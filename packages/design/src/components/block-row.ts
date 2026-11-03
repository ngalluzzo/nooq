import type { ActorKind } from "@nooq/core";
import { cx, el, type Child } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import { inkVar, type Ink } from "./actor-chip.ts";
import { button } from "./button.ts";
import { tooltip } from "./tooltip.ts";

export type BlockKind = "paragraph" | "heading" | "title" | "quote" | "list";

const TYPE_STYLE: Record<BlockKind, string> = {
  paragraph: "nq-doc-body",
  heading: "nq-doc-h2",
  title: "nq-doc-title",
  quote: "nq-doc-quote",

  list: "nq-block-list",
};
const TAG = { paragraph: "p", heading: "h2", title: "h1", quote: "blockquote", list: "li" } as const;

export interface BlockRowProps {
  /** The block's rendered content. */
  content: Child;
  kind?: BlockKind;
  /** Kind of the block's last writer (DM-5 attribution); sets the change bar. */
  actor?: ActorKind;
  /** Human last writers: their ink. */
  ink?: Ink;
  /** Last writer's name, announced on the change bar. */
  writer?: string;
  /** DM-3.4 tombstone. */
  deleted?: boolean;
  /** DM-4.8: edits made after the delete, restored with the block. */
  laterEdits?: number;
  /** The heading's level (1-6): renders as data-level, styles by level. */
  level?: number;
  /** Shows the drag handle without hover. */
  active?: boolean;
  onRestore?: () => void;
  /**
   * Opens this block's history. Present => the change bar becomes the button
   * that does it: named for the last writer, with a design tooltip on hover
   * AND focus (§9) instead of a `title` attribute. Absent => the bar stays
   * the plain attribution mark.
   */
  onHistory?: () => void;
}

export function changeBarKind(actor: ActorKind): "human" | "ai" | "machine" {
  return actor === "human" ? "human" : actor === "ai" ? "ai" : "machine";
}

export function deletedLabel(laterEdits: number): string {
  if (laterEdits <= 0) return "Deleted";
  return `Deleted with ${laterEdits} later edit${laterEdits === 1 ? "" : "s"}`;
}

/** One block on the writing surface, built-in or third-party alike (§7), with its gutter. */
export function blockRow({ content, kind = "paragraph", actor = "human", ink = "self", writer, deleted, laterEdits = 0, active, level, onHistory, onRestore }: BlockRowProps): HTMLDivElement {
  const bar = changeBarKind(actor);
  const body = deleted
    ? el(
        "div",
        { class: cx("nq-block-body", TYPE_STYLE[kind]) },
        el("del", {}, content),
        el("div", { class: "nq-tomb-meta nq-ui-body" }, el("span", {}, deletedLabel(laterEdits)), button({ label: "Restore", variant: "quiet", onClick: () => onRestore?.() })),
      )
    : el(TAG[kind], { class: cx("nq-block-body", TYPE_STYLE[kind]), ...(kind === "heading" && level !== undefined ? { "data-level": String(level) } : {}) }, content);
  // With onHistory the bar is the control that opens the history popover: a
  // real button, named for the last writer, explained by a tooltip on hover
  // AND keyboard focus — the reachable replacement for a title attribute.
  // Without it, the bar stays the plain attribution mark, exactly as before.
  const barElement = onHistory
    ? (() => {
        const control = el("button", {
          type: "button",
          class: cx("nq-bar", `nq-bar-${bar}`, "nq-bar-history"),
          "aria-label": writer ? `Block history · last edited by ${writer}` : "Block history",
          onclick: onHistory,
        });
        if (writer) tooltip({ anchor: control, text: `Last edited by ${writer}` });
        return control;
      })()
    : el("span", {
        class: cx("nq-bar", `nq-bar-${bar}`),
        role: writer ? "img" : undefined,
        "aria-label": writer ? `Last edited by ${writer}` : undefined,
        title: writer ? `Last edited by ${writer}` : undefined,
      });
  return el(
    "div",
    {
      class: cx("nq-block", `nq-block-${kind}`, deleted && "nq-block-deleted", active && "is-active"),
      style: actor === "human" ? { "--nq-peer": inkVar(ink) } : undefined,
      "data-actor": actor,
    },
    el(
      "div",
      { class: "nq-gutter" },
      el("button", { type: "button", class: "nq-handle", "aria-label": "Move block" }, glyph("grip")),
      barElement,
    ),
    body,
  );
}
