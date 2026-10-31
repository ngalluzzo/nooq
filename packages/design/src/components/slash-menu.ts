import { cx, el } from "../dom.ts";

export interface SlashMenuItem {
  label: string;
  /** Block type id from the registry: "nooq.heading/v1", "acme.callout/v2". */
  type: string;
  /** One or two characters for the glyph tile; defaults to the label's first letter. */
  glyph?: string;
  /** Markdown shortcut, e.g. "##". */
  hint?: string;
  /** The item asks an AI actor for a proposal; its output arrives as a suggestion. */
  ai?: boolean;
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  /** The text typed after "/". */
  query?: string;
  /** Index of the highlighted row. */
  active?: number;
  onSelect?: (item: SlashMenuItem, index: number) => void;
  onClose?: () => void;
}

let menuCount = 0;

/**
 * Block insertion menu. Every registered block gets the same row, built-in or
 * not (§7). Keyboard-complete (§9): arrows, Home/End, Enter, Escape.
 */
export function slashMenu({ items, query, active = 0, onSelect, onClose }: SlashMenuProps): HTMLDivElement {
  const id = `nq-menu-${++menuCount}`;
  let current = Math.min(Math.max(active, 0), Math.max(items.length - 1, 0));

  const options = items.map((item, i) =>
    el(
      "div",
      {
        id: `${id}-opt-${i}`,
        role: "option",
        class: "nq-menu-item",
        onclick: () => {
          setActive(i);
          onSelect?.(item, i);
        },
      },
      el("span", { class: cx("nq-menu-glyph", item.ai && "is-ai"), "aria-hidden": "true" }, item.glyph ?? item.label.charAt(0)),
      el("span", { class: "nq-menu-text" }, el("span", { class: "nq-ui-label" }, item.label), el("span", { class: "nq-menu-type nq-digest" }, item.type)),
      item.hint && el("kbd", { class: "nq-kbd nq-ui-caption" }, item.hint),
    ),
  );

  const listbox = el(
    "div",
    {
      role: "listbox",
      tabindex: "0",
      class: "nq-menu-list",
      "aria-label": query ? `Insert block, filtered by “${query}”` : "Insert block",
      onkeydown: (event: Event) => {
        const e = event as KeyboardEvent;
        const last = items.length - 1;
        const moves: Record<string, number> = { ArrowDown: current === last ? 0 : current + 1, ArrowUp: current === 0 ? last : current - 1, Home: 0, End: last };
        if (e.key in moves) setActive(moves[e.key]!);
        else if (e.key === "Enter" && items[current]) onSelect?.(items[current]!, current);
        else if (e.key === "Escape") onClose?.();
        else return;
        e.preventDefault();
      },
    },
    options,
  );

  function setActive(i: number): void {
    current = i;
    options.forEach((o, j) => {
      o.setAttribute("aria-selected", String(j === i));
      o.classList.toggle("is-active", j === i);
    });
    if (options[i]) listbox.setAttribute("aria-activedescendant", options[i]!.id);
  }
  setActive(current);

  return el(
    "div",
    { class: "nq-menu" },
    query !== undefined && el("div", { class: "nq-menu-query nq-code", "aria-hidden": "true" }, `/${query}`),
    listbox,
    el("div", { class: "nq-menu-foot nq-ui-caption" }, "↑↓ move · Enter insert · Esc close"),
  );
}
