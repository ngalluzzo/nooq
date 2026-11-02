import { el, type Child } from "../dom.ts";

export interface DocumentHeaderProps {
  /**
   * The document's title as the host binds it — a title block's host element
   * or the host's own title UI. The header lays this out and nothing more:
   * it never owns text editing.
   */
  title: Child;
  /** The sync line, as `syncStatus` draws it. */
  status: Child;
  /** Who is here, as the roster beside the sync line draws it. */
  roster: Child;
  /** The share/history entry point. Empty in the reference for now. */
  actions?: Child;
}

/**
 * The strip of chrome above a writing surface (foundation P2): the title
 * slot leading, sync status, roster and the host's actions trailing, all
 * wrapping on narrow widths, with one rule hairline underneath. The header
 * is chrome, so the strip is set in the Interface face (sans) and the title
 * slot renders AS GIVEN — never doc-title, which belongs to the Document
 * face inside the surface where the title block is edited. The component
 * owns layout and the rule; hosts own the title's text and every control.
 *
 * Usage: mount above a `createSurface` element, feed `status` from
 * `syncStatus` and `roster` from the same status module the surface uses,
 * and bind `title` to the document's title block or your own title UI —
 * until a host binds one the slot renders nothing. Not for anything that
 * edits: nothing in the header sits on the input path (§3), and it is not
 * a toolbar — controls the writer repeats belong in the surface.
 */
export function documentHeader(props: DocumentHeaderProps): HTMLElement {
  return el(
    "header",
    { class: "nq-header" },
    el("div", { class: "nq-header-title nq-ui-heading" }, props.title),
    el("div", { class: "nq-header-side" }, props.status, props.roster, props.actions),
  );
}
