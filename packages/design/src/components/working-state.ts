import { el } from "../dom.ts";
import { button } from "./button.ts";
import { glyph } from "../glyphs.ts";

/**
 * The hand at work (0008). `name` is the actor's display name when it has
 * one; `model` is the DM-5 model identifier — every AI edit says which model.
 */
export interface WorkingStateActor {
  name?: string;
  model: string;
}

export interface WorkingStateProps {
  actor: WorkingStateActor;
  /** DM-4 transaction intent, shown as written: "rewrite-block". */
  intent?: string;
  /** Stops the job: the runtime's cancel handle. */
  onStop: () => void;
}

/**
 * An inline strip saying who is working, on what, with Stop — the AI hand on
 * its pencil-soft ground (§5). A live region (`role="status"`, polite): this
 * strip is the screen-reader channel for a running job, which is why the
 * draft preview beside it is aria-hidden — per-delta churn is forbidden (§9).
 * Never on the input path: it mounts below the block it works on.
 */
export function workingState({ actor, intent, onStop }: WorkingStateProps): HTMLDivElement {
  return el(
    "div",
    { class: "nq-working", role: "status", "aria-live": "polite" },
    el("span", { class: "nq-working-word nq-ui-caption" }, "working"),
    el(
      "span",
      { class: "nq-working-actor nq-ui-caption" },
      actor.name !== undefined && el("span", { class: "nq-working-name" }, actor.name),
      // The kind word and the model name it (DM-5): an unnamed model is a broken promise.
      el("span", { class: "nq-working-kind" }, "AI"),
      el("span", { class: "nq-working-model" }, actor.model),
    ),
    intent !== undefined && el("span", { class: "nq-working-intent nq-digest" }, intent),
    button({ label: [glyph("stop"), "Stop"], variant: "quiet", onClick: onStop }),
  );
}

/**
 * The draft preview: a model's text-so-far as it streams (0008), set into the
 * Document face where it is created. Pencil text under a dashed pencil
 * underline, with NO wash — the pencil-soft wash means "proposed", and this
 * text is explicitly not yet a proposal; publication replaces it with the
 * suggestion card through the review flow. `aria-hidden`: the working strip's
 * live region is the screen-reader channel (§9).
 */
export function draftPreview(text = ""): HTMLParagraphElement {
  return el("p", { class: "nq-draft nq-doc-body", "aria-hidden": "true" }, text);
}
