/**
 * The document header on a real editor (foundation P2): the chrome strip a
 * host mounts above a `createSurface` element. The status slot is the same
 * status module the surface's status area uses — one `createSurfaceStatus`
 * instance here renders the roster and re-homes the page's shared announcer
 * (status.ts owns the singleton: a second instance re-homes the same live
 * region, never mounts a second one), and the sync line reads the editor
 * exactly as the surface reads it. The title slot is the host's to bind;
 * until then it renders nothing. The actions slot carries the Access button
 * (access-ui.ts) on secured documents and — when `export` is configured —
 * the Export entry point (export-ui.ts) beside it (open documents included:
 * export is not access-gated), with the host's own actions after them. The
 * reference composition (reference.ts) turns export on and composes the
 * callout formatter into its engine options.
 */
import { documentHeader, peerInk, syncStatus, type DocumentHeaderProps, type PeerInk } from "@nooq/design";
import { createAccessUI } from "./access-ui.ts";
import type { Editor } from "./controller.ts";
import { createExportUI, type ExportUIOptions } from "./export-ui.ts";
import { createSurfaceStatus } from "./status.ts";

export interface DocumentHeaderOptions {
  /**
   * The host's title UI: bind the document's title block (nooq.title/v1) or
   * your own element. Default: nothing renders until a host binds one.
   */
  title?: DocumentHeaderProps["title"];
  /** The local writer's display name; the editor exposes only its actor ID. */
  selfName?: string;
  /**
   * The host's own actions, composed into the trailing slot after the
   * access button (which renders only on a secured document — open documents
   * have no access header, so no button) and the Export button. Default: no
   * host actions.
   */
  actions?: DocumentHeaderProps["actions"];
  /**
   * Turns the Export entry point on with these options (export-ui.ts; the
   * engine's options — the reference composes block formatters here — plus
   * injectable copy/download sinks). Default: off, so a header that never
   * asked for export shows none; export is not access-gated, so when it is
   * on, open documents get it too.
   */
  export?: ExportUIOptions;
}

export interface DocumentHeader {
  /** Mount above a createSurface element; the header owns no surface. */
  element: HTMLElement;
  destroy(): void;
}

export function createDocumentHeader(editor: Editor, options: DocumentHeaderOptions = {}): DocumentHeader {
  // Peer inks hash on WebCrypto and resolve a beat late (presence.ts's
  // discipline): a peer appears once their ink resolves, never in a borrowed
  // color, and resolution triggers this header's next refresh.
  const inks = new Map<string, PeerInk>(), resolving = new Set<string>();
  const inkOf = (actor: string): PeerInk | undefined => {
    const ink = inks.get(actor);
    if (!ink && !resolving.has(actor)) {
      resolving.add(actor);
      void peerInk(actor).then(resolved => { inks.set(actor, resolved); resolving.delete(actor); refresh(); }).catch(() => { resolving.delete(actor); });
    }
    return ink;
  };
  const sync = document.createElement("span");
  const status = createSurfaceStatus(editor, { inkOf }, { selfName: options.selfName });
  // The access entry point (foundation P1): mounts only when the document
  // carries an access header — open documents show no button at all.
  const access = createAccessUI(editor, { selfName: options.selfName });
  // The export entry point (foundation P2): beside Access when configured —
  // and on open documents too, because export is not access-gated.
  const exportUI = options.export !== undefined ? createExportUI(editor, options.export) : undefined;
  const element = documentHeader({ title: options.title, status: sync, roster: status.element, actions: [access.element, exportUI?.element, options.actions] });
  let destroyed = false;
  /** The same line the surface draws: DM-8 as a neutral fact, offline first (§2). */
  const refresh = () => {
    if (destroyed) return;
    sync.replaceChildren(syncStatus({ state: editor.hasTransport ? editor.synced ? "synced" : "syncing" : "local", count: editor.awareness.size }));
    status.update([...editor.awareness.values()]);
  };
  // One subscription covers document changes, sync settling and awareness:
  // the editor funnels them all through its change listeners.
  const offChange = editor.onChange(refresh);
  let offClose = () => {};
  const destroy = () => { if (destroyed) return; destroyed = true; offChange(); offClose(); status.destroy(); access.destroy(); exportUI?.destroy(); element.remove(); };
  offClose = editor.onClose(destroy);
  refresh();
  return { element, destroy };
}
