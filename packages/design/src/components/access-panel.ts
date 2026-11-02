import type { ActorKind, Role } from "@nooq/core";
import { cx, el } from "../dom.ts";
import { actorChip, type Ink } from "./actor-chip.ts";
import { glyph } from "../glyphs.ts";

/** The role words, sentence case (DM-13's nouns; content fundamentals). */
export const ROLE_WORDS: Record<Role, string> = {
  writer: "Writer",
  suggester: "Suggester",
  reader: "Reader",
  checkpointer: "Checkpointer",
};

/** The owner's word: the access header's own noun, not a grant role. */
const OWNER_WORD = "Owner";
/** The self row's word when the access header names no role for this writer. */
const NO_ROLE_WORD = "No role";

/** One party of the access header as the panel renders it. */
interface AccessRow {
  actorId: string;
  /** The name joined from awareness, when the actor is here. Absent renders the bare actor ID — the panel invents no names. */
  name?: string;
  /** DM-5 actor kind, as the access header carries it per party. Default "human". */
  kind?: ActorKind;
  /** An AI actor's model, so the chip says which model (§5). */
  model?: string;
  role?: Role;
  /** The owner row: rendered ahead of the grants, carrying the word "Owner". */
  owner?: boolean;
  /**
   * "Their edits arrived verified here" — the weak, transitive verdict of the
   * access investigation: everything that reached this peer passed admission.
   * Never a per-actor verification claim.
   */
  verified?: boolean;
  /** The caller's judgement the writer has gone quiet. Carries the word "idle" (§9). */
  idle?: boolean;
  /** DM-13.6 (proposals/0012): the revoked roll says this actor was removed.
   *  Carries the badge "removed" (the owner's product answer: label the
   *  actor, never the mechanics) and drops the role word — they have none. */
  removed?: boolean;
  /** The owner's Remove affordance on this row (DM-13.6): rendered only when
   *  present — the panel stays presentational; the caller owns the dialog. */
  onRemove?: () => void;
  /** The derived peer ink for a human row; the caller omits the row until it resolves, never a borrowed color. */
  ink?: Ink;
}

export interface AccessPanelEntry extends AccessRow {
  /** The party's role as the access header states it. Required unless the
   *  actor is removed (DM-13.6): a removed actor has no role word. */
  role?: Role;
}

export interface AccessPanelProps {
  /** The local writer, first: chip, role word, and the word "you". */
  self: { actorId: string; name: string; kind?: ActorKind; role?: Role };
  /**
   * The owner, then every grant, as the access header replicates them. The
   * caller omits the party that is the self actor — each actor appears once.
   */
  entries: readonly AccessPanelEntry[];
}

/**
 * Who can edit this document, in which role (foundation P1, DM-12/13): the
 * body of the header's access popover. Roles read from replicated state;
 * names join from awareness by actor ID, and a grant whose actor never
 * arrived renders its bare actor ID — an honest limitation, not a fallback
 * name. "Verified" is only ever "their edits arrived verified here". A
 * removed actor (the revoked roll, DM-13.6) carries the badge "removed"
 * and no role word: label the actor, never the mechanics.
 *
 * Usage: the consumer owns the join (awareness by actor ID) and idle (the
 * roster's local 5-minute judgement); a human row appears once its derived
 * ink resolves, the same discipline as the roster. Not for open documents —
 * they have no access header at all.
 */
export function accessPanel({ self, entries }: AccessPanelProps): HTMLDivElement {
  return el(
    "div",
    { class: "nq-access" },
    el(
      "ul",
      { class: "nq-access-rows" },
      row({ actorId: self.actorId, name: self.name, kind: self.kind, role: self.role, ink: "self" }, true),
      entries.map(entry => row(entry, false)),
    ),
    el("p", { class: "nq-access-note nq-ui-caption" }, "Removing a writer takes effect per device at sync time (DM-13.6)."),
  );
}

function row(entry: AccessRow, selfRow: boolean): HTMLLIElement {
  const role = entry.owner ? OWNER_WORD : entry.role === undefined ? NO_ROLE_WORD : ROLE_WORDS[entry.role];
  return el(
    "li",
    {
      class: cx("nq-access-row", selfRow && "nq-access-self", entry.owner && "nq-access-owner"),
      "data-nq-actor": entry.actorId,
      ...(entry.owner ? { "data-owner": "" } : {}),
      ...(entry.verified ? { "data-verified": "" } : {}),
      ...(entry.idle ? { "data-idle": "" } : {}),
      ...(entry.removed ? { "data-removed": "" } : {}),
    },
    actorChip({
      kind: entry.kind ?? "human",
      name: entry.name ?? entry.actorId,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.ink !== undefined ? { ink: entry.ink } : {}),
    }),
    entry.verified && el(
      "span",
      { class: "nq-access-verified", title: "Their edits arrived verified here" },
      glyph("verified"),
      el("span", { class: "nq-sr" }, "verified"),
    ),
    entry.idle && !entry.removed && el("span", { class: "nq-access-idle nq-ui-caption" }, "idle"),
    entry.removed && el("span", { class: "nq-access-removed nq-ui-caption" }, "removed"),
    el("span", { class: "nq-access-role nq-ui-caption" }, entry.removed ? "" : role),
    entry.onRemove && !entry.removed && el(
      "button",
      { class: "nq-access-remove nq-ui-caption", type: "button", onclick: entry.onRemove },
      "Remove…",
    ),
    selfRow && el("span", { class: "nq-access-you nq-ui-caption" }, "you"),
  );
}
