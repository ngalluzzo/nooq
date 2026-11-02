/**
 * The access popover (foundation P1, built on the access investigation's
 * verdict): who can edit this document and in which role, read from
 * replicated state (DM-12/13) — the roster is `editor.accessState()`, live
 * on every peer. Display names join from awareness by actorId; a grant
 * whose actor never arrived renders its bare actor id, never an invented
 * name. "Verified" only ever means "their edits arrived verified here"
 * (`editor.arrivedVerified()`): the weak, transitive form, because
 * per-actor verification state does not exist yet.
 *
 * The Access button sits in the document header's actions slot and renders
 * only on a secured document — an open document has no access header at
 * all, so it shows no button. Click or Enter opens the design popover
 * anchored to the button; Esc closes returning focus (the popover's
 * contract); the panel re-renders on access or awareness change while open.
 */
import { accessPanel, button, glyph, peerInk, popover, type AccessPanelEntry, type PeerInk, type PopoverHandle } from "@nooq/design";
import type { ActorKind, Role } from "@nooq/core";
import type { AwarenessEntry } from "@nooq/sync";

/**
 * What this module reads from the editor: the task-17 access surface
 * (roles from replicated state, the arrived-verified set) plus the
 * awareness join every presence UI shares.
 */
export interface AccessSource {
  readonly actorId: string;
  /** Latest awareness per remote actor (SW-7); names join by actorId. */
  readonly awareness: ReadonlyMap<string, AwarenessEntry>;
  onChange(listener: () => void): () => void;
  /** The local writer's role from the access header; undefined when it names none. */
  myRole(): Role | undefined;
  /** The replicated access header; undefined on an open document — and then no button renders. */
  accessState(): AccessView | undefined;
  /** Actors whose edits arrived verified here (the weak, transitive verdict). */
  arrivedVerified(): ReadonlySet<string>;
}

/** The access shape as this module reads it; accepts a frozen or mutable `Access` alike. */
export interface AccessView {
  owner: { actorId: string; kind: ActorKind };
  grants: readonly { actorId: string; kind: ActorKind; role: Role }[];
}

/**
 * A peer counts as idle after this long without an awareness update — the
 * roster's same local judgement (status.ts): true idle wants a timestamp
 * on the wire (SW-7), and this only re-evaluates when the editor changes.
 */
const IDLE_AFTER = 5 * 60 * 1000;

export interface AccessUIOptions {
  /** The local writer's display name; the editor exposes only its actor ID. */
  selfName?: string;
  /** Injectable clock, so idle is testable. */
  now?(): number;
}

export interface AccessUI {
  /** Mounts into the header's actions slot: empty until the document has access, then the Access button. */
  element: HTMLElement;
  destroy(): void;
}

export function createAccessUI(editor: AccessSource, options: AccessUIOptions = {}): AccessUI {
  const now = options.now ?? (() => Date.now());
  const element = document.createElement("span");
  element.className = "nq-access-slot";
  let accessButton: HTMLButtonElement | undefined;
  let handle: PopoverHandle | undefined;
  let body: HTMLDivElement | undefined;
  let offRender = () => {};
  let destroyed = false;

  // A remote human's ink is a hash that resolves a beat late: rows appear
  // once it does, never in a borrowed color (the roster's discipline), and
  // resolution re-renders an open panel.
  const inks = new Map<string, PeerInk>(), resolving = new Set<string>();
  const inkOf = (actor: string): PeerInk | undefined => {
    const ink = inks.get(actor);
    if (!ink && !resolving.has(actor)) {
      resolving.add(actor);
      void peerInk(actor).then(resolved => { inks.set(actor, resolved); resolving.delete(actor); render(); }).catch(() => { resolving.delete(actor); });
    }
    return ink;
  };

  /** Last awareness entry object per actor: identity change between renders is this render's activity signal. */
  const seen = new Map<string, AwarenessEntry>();
  const lastSeen = new Map<string, number>();
  const trackActivity = (): void => {
    for (const [actor, entry] of editor.awareness) {
      if (entry.cursor === null) continue; // a departure is not activity
      if (seen.get(actor) !== entry) { seen.set(actor, entry); lastSeen.set(actor, now()); }
    }
  };

  /** The panel's rows from replicated state, awareness and the verified set; the self party renders once, first. */
  function entries(): AccessPanelEntry[] {
    const access = editor.accessState();
    if (!access) return [];
    const verified = editor.arrivedVerified();
    const nowMs = now();
    const row = (party: { actorId: string; kind: ActorKind }, role: Role, owner: boolean): AccessPanelEntry | undefined => {
      if (party.actorId === editor.actorId) return undefined; // the self row is this writer
      if (party.kind === "human") {
        if (!inkOf(party.actorId)) return undefined; // waits out the ink hash, never a borrowed color
      }
      const entry = editor.awareness.get(party.actorId);
      const present = entry !== undefined && entry.cursor !== null;
      return {
        actorId: party.actorId,
        kind: party.kind,
        role,
        ...(owner ? { owner: true } : {}),
        ...(entry?.name ? { name: entry.name } : {}),
        ...(verified.has(party.actorId) ? { verified: true } : {}),
        ...(present && nowMs - (lastSeen.get(party.actorId) ?? nowMs) > IDLE_AFTER ? { idle: true } : {}),
      };
    };
    return [
      row(access.owner, "writer", true), // partyOf: the owner writes (access.ts)
      ...access.grants.map(grant => row(grant, grant.role, false)),
    ].filter((entry): entry is AccessPanelEntry => entry !== undefined);
  }

  /** The panel for right now; also the re-render path while the popover is open. */
  function render(): void {
    if (destroyed || !body || !handle) return;
    const access = editor.accessState();
    if (!access) { handle.destroy(); return; } // access never leaves a secured document; belt and braces
    trackActivity();
    const selfParty = access.owner.actorId === editor.actorId ? access.owner : access.grants.find(grant => grant.actorId === editor.actorId);
    body.replaceChildren(accessPanel({
      self: {
        actorId: editor.actorId,
        name: options.selfName ?? editor.actorId,
        ...(selfParty ? { kind: selfParty.kind } : {}),
        role: editor.myRole(),
      },
      entries: entries(),
    }));
  }

  function close(): void {
    handle?.destroy(); // silent: onClose's bookkeeping runs below regardless
    handle = undefined;
    body = undefined;
    offRender();
    offRender = () => {};
    if (accessButton) accessButton.setAttribute("aria-expanded", "false");
  }

  function open(): void {
    if (handle || !accessButton || destroyed) return;
    body = document.createElement("div");
    handle = popover({
      anchor: accessButton,
      side: "bottom",
      content: body,
      onClose: () => { if (handle) close(); }, // Esc, outside press or blur — focus returns to the button (the popover's contract)
    });
    handle.element.setAttribute("aria-label", "Document access");
    document.body.append(handle.element);
    accessButton.setAttribute("aria-expanded", "true");
    render();
    // Access changes (an owner grants) and awareness changes re-render the open panel.
    offRender = editor.onChange(render);
  }

  /** The button mounts when the document first shows its access header; an open document never grows one. */
  function mount(): void {
    if (destroyed || accessButton || !editor.accessState()) return;
    accessButton = button({ label: [glyph("access"), "Access"], variant: "quiet", onClick: () => (handle ? close() : open()) });
    accessButton.setAttribute("aria-haspopup", "dialog");
    accessButton.setAttribute("aria-expanded", "false");
    element.append(accessButton);
  }

  const offChange = editor.onChange(() => {
    if (destroyed) return;
    mount();
    trackActivity();
    render();
  });
  mount();

  return {
    element,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      offChange();
      element.remove();
    },
  };
}
