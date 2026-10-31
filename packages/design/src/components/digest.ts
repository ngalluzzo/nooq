import { el } from "../dom.ts";

export interface DigestProps {
  /** A DM-2 fingerprint: "sha256:" + 64 lowercase hex digits. */
  value: string;
  /** DM-6.1 digest kind when several sit together: "content", "structure", "block". */
  kind?: string;
  /** Defaults to the async clipboard; rejection is ignored (the full value stays in the title). */
  copy?: (value: string) => Promise<void> | void;
}

/** First 6 and last 4 hex digits. Never shorter, so two digests stay comparable by eye. */
export function truncateDigest(value: string): string {
  const hex = value.replace(/^sha256:/, "");
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

function clipboardCopy(value: string): Promise<void> | void {
  return navigator.clipboard?.writeText(value);
}

/**
 * The accessible name starts with exactly what is visible, so voice users can
 * say what they see (WCAG 2.5.3); the full value is the description.
 */
export function digest({ value, kind, copy = clipboardCopy }: DigestProps): HTMLButtonElement {
  return el(
    "button",
    {
      type: "button",
      class: "nq-digest-chip nq-digest",
      title: value,
      onclick: () => {
        try {
          Promise.resolve(copy(value)).catch(() => {});
        } catch {
          // Clipboard refused; the title still carries the full value.
        }
      },
    },
    kind && el("span", { class: "nq-digest-kind nq-ui-caption" }, kind),
    el("span", {}, el("span", { class: "nq-digest-algo" }, "sha256:"), truncateDigest(value)),
    el("span", { class: "nq-sr" }, "(copy full value)"),
  );
}
