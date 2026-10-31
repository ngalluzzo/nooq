import type { ActorKind } from "@nooq/core";
import { cx, el, type Child } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import { inkVar, type Ink } from "./actor-chip.ts";
import { button } from "./button.ts";

export type BlockKind = "paragraph" | "heading" | "title" | "quote";

const TYPE_STYLE: Record<BlockKind, string> = {
  paragraph: "nq-doc-body",
  heading: "nq-doc-h2",
  title: "nq-doc-title",
  quote: "nq-doc-quote",
};
const TAG = { paragraph: "p", heading: "h2", title: "h1", quote: "blockquote" } as const;

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
  /** Shows the drag handle without hover. */
  active?: boolean;
  onRestore?: () => void;
}

export function changeBarKind(actor: ActorKind): "human" | "ai" | "machine" {
  return actor === "human" ? "human" : actor === "ai" ? "ai" : "machine";
}

export function deletedLabel(laterEdits: number): string {
  if (laterEdits <= 0) return "Deleted";
  return `Deleted with ${laterEdits} later edit${laterEdits === 1 ? "" : "s"}`;
}

/** One block on the writing surface, built-in or third-party alike (§7), with its gutter. */
export function blockRow({ content, kind = "paragraph", actor = "human", ink = "self", writer, deleted, laterEdits = 0, active, onRestore }: BlockRowProps): HTMLDivElement {
  const bar = changeBarKind(actor);
  const body = deleted
    ? el(
        "div",
        { class: cx("nq-block-body", TYPE_STYLE[kind]) },
        el("del", {}, content),
        el("div", { class: "nq-tomb-meta nq-ui-body" }, el("span", {}, deletedLabel(laterEdits)), button({ label: "Restore", variant: "quiet", onClick: () => onRestore?.() })),
      )
    : el(TAG[kind], { class: cx("nq-block-body", TYPE_STYLE[kind]) }, content);
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
      el("span", {
        class: cx("nq-bar", `nq-bar-${bar}`),
        role: writer ? "img" : undefined,
        "aria-label": writer ? `Last edited by ${writer}` : undefined,
        title: writer ? `Last edited by ${writer}` : undefined,
      }),
    ),
    body,
  );
}
