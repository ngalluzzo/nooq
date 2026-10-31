import { cx, el } from "../dom.ts";
import { actorChip } from "./actor-chip.ts";
import { button } from "./button.ts";
import { digest } from "./digest.ts";
import { stateTag, type SuggestionState } from "./state-tag.ts";

/** A proposal's exact ops rendered as text runs. */
export type DiffSegment = { text: string } | { ins: string } | { del: string };

export interface SuggestionCardProps {
  state: SuggestionState;
  /** The proposing AI actor's display name. */
  actor: string;
  /** DM-5 model identifier. */
  model?: string;
  /** DM-4 transaction intent, shown as written: "rewrite-intro". */
  intent?: string;
  /** Rendered from the proposal's ops verbatim (DM-6.3); never paraphrased. */
  diff: DiffSegment[];
  /** One sentence naming the drift and who caused it. Shown for stale and conflicted. */
  reason?: string;
  /** DM-6.1 evidence digests. */
  evidence?: { kind: string; value: string }[];
  /** Who accepted or rejected it (DM-5 adoption provenance). */
  settledBy?: string;
  acceptShortcut?: string;
  onAccept?: () => void;
  onReject?: () => void;
}

function renderDiff(diff: DiffSegment[]): (Node | string)[] {
  return diff.map((seg) => ("ins" in seg ? el("ins", {}, seg.ins) : "del" in seg ? el("del", {}, seg.del) : seg.text));
}

function footer(p: SuggestionCardProps): Node | (Node | false | undefined)[] {
  if (p.state === "accepted") {
    return el("span", { class: "nq-sugg-settled nq-ui-body" }, `Proposed by ${p.model ?? p.actor} · accepted by ${p.settledBy ?? "you"}`);
  }
  if (p.state === "rejected") {
    return el("span", { class: "nq-sugg-settled nq-ui-body" }, `Rejected by ${p.settledBy ?? "you"} · kept in history`);
  }
  // DM-6.3: when not fresh, accepting is still the writer's call, but it is no longer the suggested one.
  const fresh = p.state === "fresh";
  return [
    button({ label: fresh ? "Accept" : "Accept anyway", variant: fresh ? "primary" : "default", shortcut: fresh ? p.acceptShortcut : undefined, onClick: () => p.onAccept?.() }),
    button({ label: "Reject", variant: "quiet", onClick: () => p.onReject?.() }),
  ];
}

export function suggestionCard(p: SuggestionCardProps): HTMLElement {
  const settled = p.state === "accepted" || p.state === "rejected";
  const evidence = p.evidence ?? [];
  return el(
    "article",
    { class: cx("nq-sugg", `nq-sugg-${p.state}`), "aria-label": `Suggestion from ${p.actor}, ${p.state}`, "data-state": p.state },
    el(
      "header",
      { class: "nq-sugg-head" },
      actorChip({ kind: "ai", name: p.actor, model: p.model }),
      stateTag({ state: p.state }),
      p.intent && el("span", { class: "nq-sugg-intent nq-digest" }, p.intent),
    ),
    el("p", { class: "nq-sugg-diff" }, renderDiff(p.diff)),
    !settled && p.reason && el("p", { class: "nq-sugg-reason nq-ui-body" }, p.reason),
    !settled &&
      evidence.length > 0 &&
      el(
        "div",
        { class: "nq-sugg-evidence" },
        el("span", { class: "nq-sugg-label nq-ui-caption" }, "Evidence"),
        evidence.map((e) => digest(e)),
      ),
    el("footer", { class: "nq-sugg-foot" }, footer(p)),
  );
}
