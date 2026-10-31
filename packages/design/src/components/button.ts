import { cx, el, type Child } from "../dom.ts";

export interface ButtonProps {
  /** A short verb naming the outcome: "Accept", "Restore". */
  label: Child;
  /**
   * primary: the one action a writer most likely wants here (at most one per card).
   * quiet: secondary actions inside cards and rows. danger: destroys something history cannot restore.
   */
  variant?: "default" | "primary" | "quiet" | "danger";
  /** Keyboard hint for an action a writer repeats (§9), e.g. "⌘↵". */
  shortcut?: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button({ label, variant = "default", shortcut, disabled, onClick }: ButtonProps): HTMLButtonElement {
  return el(
    "button",
    {
      type: "button",
      class: cx("nq-btn", "nq-ui-label", variant !== "default" && `nq-btn-${variant}`),
      disabled,
      "aria-keyshortcuts": shortcut ? toAriaShortcut(shortcut) : undefined,
      onclick: onClick,
    },
    label,
    shortcut && el("kbd", { class: "nq-kbd nq-ui-caption" }, shortcut),
  );
}

const KEY_NAMES: Record<string, string> = { "⌘": "Meta", "⌃": "Control", "⌥": "Alt", "⇧": "Shift", "↵": "Enter", "⌫": "Backspace" };

/** "⌘↵" → "Meta+Enter", for assistive technology. */
export function toAriaShortcut(shortcut: string): string {
  return [...shortcut].map((c) => KEY_NAMES[c] ?? c).join("+");
}
