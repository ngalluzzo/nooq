import { cx, el, type Child } from "../dom.ts";

/** The side the caller prefers; `computePlacement` flips it when it cannot fit. */
export type PopoverSide = "top" | "right" | "bottom" | "left";

/** How a writer dismissed the popover. `destroy()` is programmatic teardown and reports nothing. */
export type PopoverCloseReason = "escape" | "outside" | "blur";

/** An axis-aligned box in viewport coordinates. */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ComputePlacementInput {
  anchor: Box;
  floating: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Preferred side. Default "bottom". */
  side?: PopoverSide;
  /** Space kept between the floating box and every viewport edge. Default 8 (`--nq-space-2`). */
  margin?: number;
  /** Space between the anchor and the floating box. Default 8 (`--nq-space-2`). */
  gap?: number;
}

/** Where the floating box should sit: its top-left corner in viewport coordinates. */
export interface Placement {
  side: PopoverSide;
  x: number;
  y: number;
  /** True when the preferred side did not fit and the placement flipped. */
  flipped: boolean;
}

/** Same spacing the theme gives floating surfaces (`--nq-space-2`), for math that must be numeric. */
const SPACE_2 = 8;

const OPPOSITE: Record<PopoverSide, PopoverSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * Pure collision math for one anchored box: flip to the opposite side when
 * the preferred one cannot fit between the anchor and the viewport edge, then
 * shift along the cross axis so the box stays inside the viewport. No DOM, so
 * it runs anywhere and tests without layout.
 */
export function computePlacement({
  anchor,
  floating,
  viewport,
  side = "bottom",
  margin = SPACE_2,
  gap = SPACE_2,
}: ComputePlacementInput): Placement {
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const room = {
    top: anchor.top - margin,
    bottom: viewport.height - margin - bottom,
    left: anchor.left - margin,
    right: viewport.width - margin - right,
  };
  const fits = {
    top: room.top >= gap + floating.height,
    bottom: room.bottom >= gap + floating.height,
    left: room.left >= gap + floating.width,
    right: room.right >= gap + floating.width,
  };

  let chosen = side;
  let flipped = false;
  if (!fits[side]) {
    const opposite = OPPOSITE[side];
    if (fits[opposite]) {
      chosen = opposite;
      flipped = true;
    } else {
      // Neither side fits: take the roomier one and let the shift below clamp.
      chosen = room[side] >= room[opposite] ? side : opposite;
      flipped = chosen !== side;
    }
  }

  let x: number;
  let y: number;
  if (chosen === "top" || chosen === "bottom") {
    y = chosen === "bottom" ? bottom + gap : anchor.top - gap - floating.height;
    const maxX = Math.max(margin, viewport.width - margin - floating.width);
    x = Math.min(Math.max(anchor.left, margin), maxX);
  } else {
    x = chosen === "right" ? right + gap : anchor.left - gap - floating.width;
    const maxY = Math.max(margin, viewport.height - margin - floating.height);
    y = Math.min(Math.max(anchor.top, margin), maxY);
  }
  return { side: chosen, x, y, flipped };
}

export interface PopoverOptions {
  /** The element to anchor to. Must be in the document; give it a tabindex if it is not focusable. */
  anchor: HTMLElement;
  /** Preferred side. Default "bottom". */
  side?: PopoverSide;
  /** The popover body: any DOM or text. Its children carry their own roles and focus. */
  content: Child;
  /** WAI-ARIA role for the container, e.g. "tooltip". Omitted by default: the content provides semantics. */
  role?: string;
  /** Id, so other elements can reference the popover (e.g. `aria-describedby`). */
  id?: string;
  /** Move focus into the popover when it opens. Default true; a tooltip passes false and keeps focus on its anchor. */
  focus?: boolean;
  /** Extra classes layered on `.nq-popover`, e.g. "nq-tooltip". */
  class?: string;
  /** Called when the writer dismisses it with Escape, an outside pointer press, or by moving focus away. */
  onClose?: (reason: PopoverCloseReason) => void;
}

export interface PopoverHandle {
  element: HTMLElement;
  /** Remove the popover and its listeners. Silent: `onClose` is not called. */
  destroy(): void;
}

/** Open popovers, innermost last, so Escape closes one surface at a time. */
const stack: Array<(reason: PopoverCloseReason) => void> = [];

/**
 * One anchored, non-modal surface: the slash menu, toolbar overflow, link
 * editing and block history all sit on it. Caller appends `element` (in the
 * same tick) wherever it mounts overlays — placement is `position: fixed`
 * against the viewport. Dismissible with Escape and an outside press; focus
 * moves in on open and returns to the anchor when it closes while inside.
 * Cleanup is AbortController-style: `destroy()` removes listeners and element.
 */
export function popover({ anchor, side = "bottom", content, role, id, focus = true, class: extra, onClose }: PopoverOptions): PopoverHandle {
  const controller = new AbortController();
  const signal = { signal: controller.signal };
  // Position travels as custom properties (like --nq-peer on a chip), so the
  // theme owns every painted value; no ad-hoc inline styles.
  const element = el(
    "div",
    {
      class: cx("nq-popover", extra),
      role,
      id,
      tabindex: "-1",
      "data-side": side,
      style: { "--nq-x": "0px", "--nq-y": "0px" },
    },
    content,
  );

  let closed = false;

  function position(): void {
    if (closed) return;
    const rect = anchor.getBoundingClientRect();
    let { offsetWidth: width, offsetHeight: height } = element;
    if (!element.isConnected && document.body) {
      // Measure without waiting for the caller to append: attach and detach
      // in the same synchronous turn, so nothing is ever painted.
      document.body.append(element);
      width = element.offsetWidth;
      height = element.offsetHeight;
      element.remove();
    }
    const placed = computePlacement({
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      floating: { width, height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      side,
    });
    element.style.setProperty("--nq-x", `${Math.round(placed.x)}px`);
    element.style.setProperty("--nq-y", `${Math.round(placed.y)}px`);
    element.setAttribute("data-side", placed.side);
    element.setAttribute("data-flipped", String(placed.flipped));
  }

  function dismiss(reason?: PopoverCloseReason): void {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(dismiss);
    if (index >= 0) stack.splice(index, 1);
    // Return focus only when it would otherwise be stranded inside the closed
    // surface; a blur that already moved it elsewhere is left where the writer put it.
    if (element.contains(document.activeElement)) anchor.focus();
    controller.abort();
    element.remove();
    if (reason) onClose?.(reason);
  }
  stack.push(dismiss);

  position();
  window.addEventListener("resize", position, { ...signal, passive: true });
  window.addEventListener("scroll", position, { ...signal, capture: true, passive: true });

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event as KeyboardEvent).key !== "Escape" || stack[stack.length - 1] !== dismiss) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss("escape");
    },
    { ...signal, capture: true },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Node) || element.contains(target) || anchor.contains(target)) return;
      dismiss("outside");
    },
    { ...signal, capture: true },
  );
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (closed || !(target instanceof Node) || element.contains(target) || anchor.contains(target)) return;
      dismiss("blur");
    },
    signal,
  );

  if (focus) {
    const moveIn = (): void => {
      if (!closed && element.isConnected) element.focus();
    };
    // The caller appends right after this call; both hooks run before the next paint.
    queueMicrotask(moveIn);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(moveIn);
  }

  return { element, destroy: () => dismiss() };
}
