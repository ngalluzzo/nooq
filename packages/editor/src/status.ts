/**
 * The status area's presence half (foundation: Presence roster + Announcer).
 * The roster sits beside the sync line — who is here, in which ink — and one
 * shared polite live region says semantic events ("Tomás joined.",
 * "Suggestion is now stale."), rate-limited inside the announcer so bursts
 * never churn assistive output (§9).
 */
import { announcer, presenceRoster, type Announcer, type PeerInk } from "@nooq/design";
import type { AwarenessEntry } from "@nooq/sync";
import type { Editor } from "./controller.ts";

/**
 * A peer counts as idle after this long without an awareness update. Activity
 * is an awareness entry's object identity changing between renders — a peer
 * sitting still sends nothing, so time passes them into idle. TRUE idle wants
 * an awareness timestamp on the wire later (SW-7); until then this is a local
 * judgement, and it only re-evaluates when the surface renders.
 */
const IDLE_AFTER = 5 * 60 * 1000;

export interface SurfaceStatus {
  /** Mounts beside the sync line; holds the roster and the shared live region. */
  element: HTMLElement;
  /** Call on every render with the editor's awareness values. */
  update(peers: readonly AwarenessEntry[]): void;
  destroy(): void;
}

export interface SurfaceStatusOptions {
  /** The local writer's display name; the editor exposes only its actor ID. */
  selfName?: string;
  /** Injectable clock, so idle is testable. */
  now?(): number;
}

let shared: Announcer | undefined;

/** The page's one announcer: created on first use, its region never replaced. */
export function sharedAnnouncer(): Announcer {
  return shared ??= announcer();
}

/**
 * Swap the shared announcer — a host with its own live region can plug it in,
 * and tests inject fake timing. Returns the previous one so callers can restore.
 */
export function setSharedAnnouncer(next: Announcer | undefined): Announcer | undefined {
  const was = shared;
  shared = next;
  return was;
}

/** Say one semantic event through the shared live region (rate-limited inside). */
export function announce(text: string): void {
  sharedAnnouncer().say(text);
}

export function createSurfaceStatus(
  editor: Editor,
  presence: { inkOf(actor: string): PeerInk | undefined },
  options: SurfaceStatusOptions = {},
): SurfaceStatus {
  const now = options.now ?? (() => Date.now());
  const element = document.createElement("span");
  const roster = document.createElement("span");
  // The region rides with the status area but is owned by the module: mounting
  // another surface re-homes the same node, and destroying one never replaces it.
  const live = sharedAnnouncer();
  element.append(roster, live.element);
  /** An actor is here while their latest awareness entry carries a cursor; null is the departure (SW-7). */
  const here = (peers: readonly AwarenessEntry[]) => peers.filter(peer => peer.cursor !== null);
  /** Last entry object seen per actor: identity change between renders = activity. */
  const seen = new Map<string, AwarenessEntry>();
  const lastSeen = new Map<string, number>();
  let present: Set<string> | undefined; // undefined until the first update establishes who is already here
  let destroyed = false;

  return {
    element,
    update(peers) {
      if (destroyed) return;
      const nowMs = now(), current = here(peers);
      // Awareness key diffs: joins and leaves as the wire reports them.
      const keys = new Set(current.map(peer => peer.actor));
      if (present === undefined) present = keys; // the baseline: peers already here when the surface appears were not "just joined"
      else {
        for (const peer of current) if (!present.has(peer.actor)) announce(`${peer.name ?? peer.actor} joined.`);
        for (const actor of present) if (!keys.has(actor)) announce(`${seen.get(actor)?.name ?? actor} left.`);
        present = keys;
      }
      // Idle bookkeeping (see IDLE_AFTER): a changed entry object is this render's activity signal.
      for (const peer of current) if (seen.get(peer.actor) !== peer) { seen.set(peer.actor, peer); lastSeen.set(peer.actor, nowMs); }
      for (const actor of [...seen.keys()]) if (!keys.has(actor)) { seen.delete(actor); lastSeen.delete(actor); }
      // A peer appears once their ink resolves — never in a borrowed color, the
      // same discipline as the overlay chips; resolution triggers the surface's
      // next render, which lands them here.
      roster.replaceChildren(presenceRoster({
        self: options.selfName ?? editor.actorId,
        peers: current.flatMap(peer => {
          const ink = presence.inkOf(peer.actor);
          if (!ink) return [];
          const idle = nowMs - (lastSeen.get(peer.actor) ?? nowMs) > IDLE_AFTER;
          return [{ actor: peer.actor, name: peer.name ?? peer.actor, ink, ...(idle ? { idle: true } : {}) }];
        }),
      }));
    },
    destroy() {
      destroyed = true;
      element.remove();
    },
  };
}
