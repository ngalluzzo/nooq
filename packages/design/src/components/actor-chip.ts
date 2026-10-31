import type { ActorKind } from "@nooq/core";
import { cx, el } from "../dom.ts";
import type { PeerInk } from "../peer.ts";

/** A writer's ink: their derived peer ink, or "self" for the local writer (ink). */
export type Ink = PeerInk | "self";

export function inkVar(ink: Ink): string {
  return ink === "self" ? "var(--nq-ink)" : `var(--nq-peer-${ink})`;
}

export const KIND_LABEL: Record<Exclude<ActorKind, "human">, string> = {
  ai: "AI",
  importer: "Importer",
  migration: "Migration",
  system: "System",
};

export interface ActorChipProps {
  /** DM-5 actor kind. */
  kind?: ActorKind;
  /** A person's name, or a machine actor's display name ("Docx importer"). */
  name: string;
  /** DM-5 model identifier. Required in spirit for AI actors: an unnamed model breaks §5. */
  model?: string;
  /** Human actors only. */
  ink?: Ink;
}

export function actorChip({ kind = "human", name, model, ink = "self" }: ActorChipProps): HTMLSpanElement {
  return el(
    "span",
    { class: cx("nq-actor", `nq-actor-${kind}`), style: kind === "human" ? { "--nq-peer": inkVar(ink) } : undefined },
    el("span", { class: "nq-actor-mark", "aria-hidden": "true" }),
    el("span", { class: "nq-actor-name nq-ui-label" }, name),
    kind === "ai" && model && el("span", { class: "nq-actor-model nq-digest" }, model),
    kind !== "human" && el("span", { class: "nq-actor-kind nq-ui-caption" }, KIND_LABEL[kind]),
  );
}
