import { cx, el, type Child } from "../dom.ts";

/**
 * The frame's tones. Hue means an actor (§5), so a tone never tints a
 * severity: `pencil` is reserved for AI-made content, `stamp` for structural
 * problems, and everything else stays neutral. The word carries the meaning.
 */
export type ContainerTone = "neutral" | "ink" | "pencil" | "stamp";
export const CONTAINER_TONES: readonly ContainerTone[] = ["neutral", "ink", "pencil", "stamp"];

export interface BlockContainerProps {
  /** The block's label word, shown in the header. */
  label: string;
  /** The frame's tone. Always also a word in the header (§9). Omit for an untoned resting frame. */
  tone?: ContainerTone;
  /** Header state slot: a live region, a StateTag, or other per-block state. */
  state?: Child;
  /** The body slot: the element the host's text binding renders into. */
  body?: Child;
  /** The children slot: nested blocks. */
  children?: Child;
  /** The controls slot: the block's action toolbar. */
  controls?: Child;
}

const toneClass = (tone: ContainerTone) => `nq-tone-${tone}`;

function slot(name: string, content: Child): HTMLDivElement | null {
  if (content === undefined || content === null || content === false) return null;
  return el("div", { class: name }, content);
}

/**
 * The container every plugin block sits in, built-in or third-party (§7):
 * a header with the label word, an optional state slot, a body slot for the
 * text host, a children slot and a controls slot. Blocks are rectangles —
 * radius-sm, never a colored left border — and tone shows as a word and a
 * ground. All styling is theme classes; the consumer provides the slots and
 * never sets a color, border or spacing itself.
 *
 * Not for chrome that floats over the document (use the menu/popover
 * primitives) or for inline notices on the error channel. Use `pencil` only
 * for content an AI authored and `stamp` only when structure broke.
 */
export function blockContainer({ label, tone, state, body, children, controls }: BlockContainerProps): HTMLDivElement {
  return el(
    "div",
    { class: cx("nq-block-container", tone && toneClass(tone)), "data-tone": tone },
    // A plain div, not <header>: a plugin block lands inside arbitrary host
    // markup, where repeated banner landmarks would trip landmark-unique.
    el(
      "div",
      { class: "nq-block-container-head" },
      el("span", { class: "nq-block-container-label nq-ui-label" }, label),
      tone !== undefined && el("span", { class: "nq-block-container-tone nq-ui-caption" }, tone),
      slot("nq-block-container-state", state),
    ),
    slot("nq-block-container-body", body),
    slot("nq-block-container-children", children),
    slot("nq-block-container-controls", controls),
  );
}

/**
 * Refresh a mounted container's tone in place: same frame, new word and
 * ground, no animation (§3). Creates the tone word if the container was
 * mounted without one.
 */
export function setBlockContainerTone(container: HTMLElement, tone: ContainerTone): void {
  container.classList.remove(...CONTAINER_TONES.map(toneClass));
  container.classList.add(toneClass(tone));
  container.dataset.tone = tone;
  const head = container.querySelector(".nq-block-container-head");
  const word = head?.querySelector(".nq-block-container-tone") ?? el("span", { class: "nq-block-container-tone nq-ui-caption" });
  word.textContent = tone;
  if (!word.isConnected && head) head.append(word);
}
