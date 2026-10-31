import { el, type Child } from "../dom.ts";
import type { PeerInk } from "../peer.ts";

export interface PresenceCaretProps {
  name: string;
  /** Derived from the writer's actor ID with peerInk(). */
  ink: PeerInk;
  /** Text the remote writer has selected, rendered before the caret. */
  selection?: Child;
}

/**
 * A remote writer's caret, name flag and selection, inline in text. The flag
 * always shows: two writers can derive the same ink, and the name tells them apart.
 */
export function presenceCaret({ name, ink, selection }: PresenceCaretProps): HTMLSpanElement {
  return el(
    "span",
    { class: "nq-peer", style: { "--nq-peer": `var(--nq-peer-${ink})` }, "data-ink": ink },
    selection !== undefined && el("span", { class: "nq-peer-sel" }, selection),
    el("span", { class: "nq-peer-caret", "aria-hidden": "true" }, el("span", { class: "nq-peer-flag" }, name)),
    el("span", { class: "nq-sr" }, `${name}’s cursor`),
  );
}

/** The local writer's caret. Blinks unless reduced motion is set. */
export function caret(): HTMLSpanElement {
  return el("span", { class: "nq-caret", "aria-hidden": "true" });
}
