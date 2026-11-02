/**
 * The shortcut sheet (foundation P2): the keyboard reference, generated from
 * registered actions and keymaps so it can't drift. Rows pair each action's
 * label with its keys, rendered verbatim as `.nq-kbd` chips — one chip per
 * registered key string ("Ctrl+Shift+K" style), never a re-spelling that
 * could fall out of step with the registry.
 *
 * Usage: content only. The consumer (the editor surface) collects the groups
 * from its live registry and wraps the sheet in a `popover()`; the sheet is
 * reference UI and may take focus, but it is never part of the input path.
 * Not for command palettes or anything that executes an action — this
 * component only shows what keys do.
 */
import { el } from "../dom.ts";

export interface ShortcutSheetEntry {
  /** The action's human label, exactly as registered ("Bold", "Insert callout"). */
  label: string;
  /** Every key string registered for the action; each renders as one chip, verbatim. */
  keys: readonly string[];
}

export interface ShortcutSheetGroup {
  /** The section title ("Text editing"); a caption in graphite-muted. */
  title: string;
  entries: readonly ShortcutSheetEntry[];
}

export interface ShortcutSheetProps {
  groups: readonly ShortcutSheetGroup[];
}

let sheetCount = 0;

export function shortcutSheet({ groups }: ShortcutSheetProps): HTMLElement {
  const sections = groups
    .filter((group) => group.entries.length > 0)
    .map((group) => {
      const titleId = `nq-shortcuts-title-${++sheetCount}`;
      return el(
        "section",
        { class: "nq-shortcuts-group", role: "group", "aria-labelledby": titleId },
        el("div", { class: "nq-shortcuts-title nq-ui-caption", id: titleId }, group.title),
        el(
          "ul",
          { class: "nq-shortcuts-list" },
          group.entries.map((entry) =>
            el(
              "li",
              { class: "nq-shortcuts-row" },
              el("span", { class: "nq-shortcuts-label nq-ui-body" }, entry.label),
              el(
                "span",
                { class: "nq-shortcuts-keys" },
                entry.keys.map((key) => el("kbd", { class: "nq-kbd nq-ui-caption" }, key)),
              ),
            ),
          ),
        ),
      );
    });
  return el("div", { class: "nq-shortcuts" }, sections);
}
