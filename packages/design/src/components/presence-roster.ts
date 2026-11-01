import { el } from "../dom.ts";
import type { PeerInk } from "../peer.ts";

/** A remote writer as the roster shows them. `idle` is the caller's judgement. */
export interface PresenceRosterPeer {
  /** The writer's actor ID: identity for diffing membership between renders. */
  actor: string;
  /** The name as given; the roster invents no fallback. */
  name: string;
  /** Derived from the actor ID with peerInk(). */
  ink: PeerInk;
  /**
   * The caller's judgement that the writer has gone quiet. The roster dims
   * the name AND adds the word "idle": dimming never carries state alone (§9).
   */
  idle?: boolean;
}

export interface PresenceRosterProps {
  /** The local writer's name; rendered first, with the ink dot in ink. */
  self: string;
  peers: readonly PresenceRosterPeer[];
}

/**
 * Who is here, in which ink: a compact inline wrap for the document header.
 * The self chip leads (its dot is ink); each peer carries their derived ink
 * dot — radius-full, the only full-radius shape in the system — and their
 * name in ui-label. An idle peer's name dims to graphite-muted AND carries
 * the word "idle" in ui-caption: state as a word, never dimming alone (§9).
 *
 * Usage: the consumer owns membership and idle — the roster cannot know
 * either — and hosts cap the row or let it wrap. Two peers may derive the
 * same ink; their names tell them apart, which is why names always render.
 * Not for the overlay: PresenceCaret owns carets and flags inside text.
 */
export function presenceRoster({ self, peers }: PresenceRosterProps): HTMLSpanElement {
  return el(
    "span",
    { class: "nq-roster" },
    el(
      "span",
      { class: "nq-roster-self" },
      el("span", { class: "nq-roster-dot", "aria-hidden": "true" }),
      el("span", { class: "nq-roster-name nq-ui-label" }, self),
    ),
    peers.map(peer => el(
      "span",
      { class: "nq-roster-peer", "data-nq-actor": peer.actor, ...(peer.idle ? { "data-idle": "" } : {}), style: { "--nq-peer": `var(--nq-peer-${peer.ink})` } },
      el("span", { class: "nq-roster-dot", "aria-hidden": "true" }),
      el("span", { class: "nq-roster-name nq-ui-label" }, peer.name),
      peer.idle && el("span", { class: "nq-roster-idle nq-ui-caption" }, "idle"),
    )),
  );
}
