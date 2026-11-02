import { cx, el, type Child } from "../dom.ts";
import { button } from "./button.ts";
import { glyph, type GlyphName } from "../glyphs.ts";

/**
 * What the notice is about. The kind sets the glyph and the fill; the word is
 * always the caller's, naming the actor or cause.
 *
 * - `error` — the editor's error channel (a plugin, view or observer failed).
 * - `hold` — an authorization hold (0001: retryable). Patient, graphite-muted.
 * - `denial` — an authorization refusal. The reason, plainly, in a
 *   rule-strong outline. Never `stamp`: stamp is for structure that broke.
 * - `model` — a model job failed. Names the model (§5).
 * - `superseded` — a concurrent peer's move won the placement register
 *   (DM-4.9). History, not harm: both transactions persist and the document
 *   is correct, so the kind carries no fill escalation — the base treatment
 *   (graphite on transparent) lets the word and the clock glyph state the
 *   fact without borrowing the error channel's gravity.
 */
export type NoticeKind = "error" | "hold" | "denial" | "model" | "superseded";

export interface NoticeAction {
  /** A short verb naming the outcome: "Retry", "Restore". No "please". */
  label: string;
  onClick: (event: MouseEvent) => void;
}

export interface NoticeProps {
  kind?: NoticeKind;
  /**
   * What happened, in one sentence that names the actor or cause: "Maya
   * deleted the block this suggestion targets." Spec nouns (suggestion,
   * block, actor, digest), no exclamation marks.
   */
  word: Child;
  /** One optional action. A notice never demands one. */
  action?: NoticeAction;
}

/**
 * The superseded glyph is the history clock, not undo: the race is a fact of
 * the document's history that both transactions persist (an undo arrow would
 * promise reversal the notice must not), and `more` would shrug at what the
 * word states plainly.
 */
const GLYPHS: Record<NoticeKind, GlyphName> = { error: "warning", hold: "access", denial: "stop", model: "model", superseded: "history" };

/**
 * An inline, non-blocking notice: a word, a glyph, an optional action. A live
 * region (`role="status"`, polite), never a modal, and the caller places it
 * beside the writing surface, never on the input path (§2, §3). A hold reads
 * differently from a denial: the hold waits in graphite-muted, the denial
 * states its reason inside a rule-strong outline.
 */
export function notice({ kind = "error", word, action }: NoticeProps): HTMLDivElement {
  return el(
    "div",
    { class: cx("nq-notice", `nq-notice-${kind}`), role: "status", "aria-live": "polite", "data-kind": kind },
    glyph(GLYPHS[kind]),
    el("span", { class: "nq-notice-word nq-ui-body" }, word),
    action && button({ label: action.label, variant: "quiet", onClick: action.onClick }),
  );
}
