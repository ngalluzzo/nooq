import { el } from "../dom.ts";
import { popover, type PopoverHandle, type PopoverSide } from "./popover.ts";

let tipCount = 0;

export interface TooltipOptions {
  /** The element the hint explains. Gets `aria-describedby` while the tip is open. */
  anchor: HTMLElement;
  /**
   * The hint: one short sentence that names the thing, not the gesture
   * ("Restores this block to Maya's version", never "Click here"). Replaces
   * a `title` attribute, which keyboard and touch writers cannot reach.
   */
  text: string;
  /** Preferred side. Default "top". */
  side?: PopoverSide;
}

export interface TooltipHandle {
  show(): void;
  hide(): void;
  /** Remove the wiring and any open tip. */
  destroy(): void;
}

/**
 * A hint for any control, built on the popover primitive. Opens on pointer
 * hover and on keyboard focus of the anchor, closes on leave, blur and
 * Escape. While open the anchor carries `aria-describedby`, so the hint
 * reaches screen readers instead of hiding in a `title` attribute.
 */
export function tooltip({ anchor, text, side = "top" }: TooltipOptions): TooltipHandle {
  const controller = new AbortController();
  const signal = { signal: controller.signal };
  const id = `nq-tip-${++tipCount}`;
  const describedBy = anchor.getAttribute("aria-describedby");

  let open: PopoverHandle | null = null;
  let hovering = false;
  let focused = false;

  function show(): void {
    if (open) return;
    // focus: false — a tooltip must never take focus from the control it explains.
    open = popover({
      anchor,
      side,
      role: "tooltip",
      id,
      focus: false,
      class: "nq-tooltip",
      content: el("span", { class: "nq-ui-caption" }, text),
      onClose: () => hide(),
    });
    document.body.append(open.element);
    anchor.setAttribute("aria-describedby", id);
  }

  function hide(): void {
    if (!open) return;
    open.destroy();
    open = null;
    if (describedBy === null) anchor.removeAttribute("aria-describedby");
    else anchor.setAttribute("aria-describedby", describedBy);
  }

  const update = (): void => (hovering || focused ? show() : hide());

  anchor.addEventListener("pointerenter", () => { hovering = true; update(); }, signal);
  anchor.addEventListener("pointerleave", () => { hovering = false; update(); }, signal);
  anchor.addEventListener("focusin", () => { focused = true; update(); }, signal);
  anchor.addEventListener("focusout", () => { focused = false; update(); }, signal);
  anchor.addEventListener(
    "keydown",
    (event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      // Normally the popover consumes Escape first; this covers a tip that is not the top surface.
      hovering = false;
      focused = false;
      update();
    },
    signal,
  );

  return { show, hide, destroy: () => { hide(); controller.abort(); } };
}
