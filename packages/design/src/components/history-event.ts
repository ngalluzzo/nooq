import { el } from "../dom.ts";

/**
 * The document history's event line (DM-13.6, proposals/0012): one plain
 * sentence for one governance event — "Maya was removed from this document."
 * The owner's product answer: label the actor, never the mechanics. The
 * wire's vocabulary (epochs, rolls, verdicts) lives in provenance detail
 * panes and specs, not here.
 */
export function historyEvent(sentence: string): HTMLLIElement {
  return el("li", { class: "nq-history-event nq-ui-caption" }, sentence);
}
