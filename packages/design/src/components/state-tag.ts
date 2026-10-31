import type { SuggestionStatus } from "@nooq/core";
import { el } from "../dom.ts";
import { glyph } from "../glyphs.ts";

/** DM-6.2: evaluate() derives fresh | stale | conflicted; accept and reject settle a proposal. */
export type SuggestionState = SuggestionStatus | "accepted" | "rejected";
export const SUGGESTION_STATES: readonly SuggestionState[] = ["fresh", "stale", "conflicted", "accepted", "rejected"];

export interface StateTagProps {
  /** What evaluate() returned just now. Never store it; it changes with the document (DM-6.5). */
  state: SuggestionState;
}

/** Word, glyph and fill, so no state depends on color alone (§9). The word is the spec's word. */
export function stateTag({ state }: StateTagProps): HTMLSpanElement {
  return el("span", { class: `nq-state nq-state-${state} nq-ui-caption`, "data-state": state }, glyph(state), state);
}
