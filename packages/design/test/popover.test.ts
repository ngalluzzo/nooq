import "./dom.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  computePlacement,
  popover,
  tooltip,
  type Box,
  type PopoverCloseReason,
  type PopoverHandle,
} from "../src/index.ts";

const box = (top: number, left: number, width: number, height: number): Box => ({ top, left, width, height });
const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const press = (target: EventTarget) => target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));

/** An anchor plus an open popover, both mounted; pass content to vary the body. */
function mounted(onClose?: (reason: PopoverCloseReason) => void): { anchor: HTMLButtonElement; handle: PopoverHandle } {
  const anchor = document.createElement("button");
  anchor.textContent = "Block history";
  document.body.append(anchor);
  const handle = popover({ anchor, content: "Body", onClose });
  document.body.append(handle.element);
  return { anchor, handle };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("computePlacement", () => {
  const viewport = { width: 1000, height: 800 };

  test("a roomy viewport keeps the preferred side, aligned to the anchor's start", () => {
    const p = computePlacement({ anchor: box(100, 100, 100, 40), floating: { width: 200, height: 100 }, viewport, side: "bottom" });
    expect(p).toEqual({ side: "bottom", x: 100, y: 148, flipped: false });
  });

  test("no room below flips to the top", () => {
    const p = computePlacement({ anchor: box(700, 100, 100, 40), floating: { width: 200, height: 100 }, viewport, side: "bottom" });
    expect(p.flipped).toBe(true);
    expect(p.side).toBe("top");
    expect(p.y).toBe(700 - 8 - 100);
  });

  test("no room above flips to the bottom", () => {
    const p = computePlacement({ anchor: box(20, 100, 100, 40), floating: { width: 200, height: 100 }, viewport, side: "top" });
    expect(p).toEqual({ side: "bottom", x: 100, y: 68, flipped: true });
  });

  test("no room to the right flips to the left", () => {
    const p = computePlacement({ anchor: box(100, 900, 60, 40), floating: { width: 200, height: 100 }, viewport, side: "right" });
    expect(p.flipped).toBe(true);
    expect(p.side).toBe("left");
    expect(p.x).toBe(900 - 8 - 200);
  });

  test("roomy left and right sides sit beside the anchor, top-aligned", () => {
    const right = computePlacement({ anchor: box(100, 100, 100, 40), floating: { width: 80, height: 60 }, viewport, side: "right" });
    expect(right).toEqual({ side: "right", x: 208, y: 100, flipped: false });
    const left = computePlacement({ anchor: box(100, 500, 100, 40), floating: { width: 80, height: 60 }, viewport, side: "left" });
    expect(left).toEqual({ side: "left", x: 500 - 8 - 80, y: 100, flipped: false });
  });

  test("the cross axis shifts to keep the box inside the viewport", () => {
    const nearRight = computePlacement({ anchor: box(100, 960, 30, 40), floating: { width: 200, height: 100 }, viewport, side: "bottom" });
    expect(nearRight.side).toBe("bottom");
    expect(nearRight.x).toBe(1000 - 8 - 200);
    const nearLeft = computePlacement({ anchor: box(100, 0, 30, 40), floating: { width: 200, height: 100 }, viewport, side: "bottom" });
    expect(nearLeft.x).toBe(8);
    const belowFloor = computePlacement({ anchor: box(200, 100, 30, 40), floating: { width: 80, height: 700 }, viewport, side: "right" });
    expect(belowFloor.y).toBe(800 - 8 - 700);
  });

  test("when neither side fits, the roomier one wins and shift clamps it", () => {
    const tiny = { width: 300, height: 120 };
    // room above: 40-8=32; room below: 120-8-80=32 — tie keeps the preferred side.
    const tie = computePlacement({ anchor: box(40, 10, 20, 40), floating: { width: 100, height: 200 }, viewport: tiny, side: "bottom" });
    expect(tie.side).toBe("bottom");
    expect(tie.flipped).toBe(false);
    // room below is larger, so a preferred top flips despite neither fitting.
    const roomier = computePlacement({ anchor: box(20, 10, 20, 30), floating: { width: 100, height: 200 }, viewport: tiny, side: "top" });
    expect(roomier.side).toBe("bottom");
    expect(roomier.flipped).toBe(true);
    // Clamped into the viewport, above its floor.
    expect(roomier.y).toBeLessThanOrEqual(120 - 8);
  });

  test("gap and margin are respected on both axes", () => {
    const p = computePlacement({
      anchor: box(100, 100, 100, 40),
      floating: { width: 50, height: 50 },
      viewport: { width: 400, height: 400 },
      side: "bottom",
      gap: 20,
      margin: 30,
    });
    expect(p.y).toBe(140 + 20);
    const shifted = computePlacement({
      anchor: box(10, 0, 20, 20),
      floating: { width: 100, height: 40 },
      viewport: { width: 400, height: 400 },
      side: "bottom",
      margin: 30,
    });
    expect(shifted.x).toBe(30);
  });
});

describe("popover", () => {
  test("renders the anchored surface, positioned and marked with its side", () => {
    const { handle } = mounted();
    const el = handle.element;
    expect(el.classList.contains("nq-popover")).toBe(true);
    expect((el as HTMLElement).tabIndex).toBe(-1);
    expect(el.style.getPropertyValue("--nq-x")).toMatch(/px$/);
    expect(el.style.getPropertyValue("--nq-y")).toMatch(/px$/);
    expect(el.getAttribute("data-side")).toBe("bottom");
    expect(el.textContent).toBe("Body");
    handle.destroy();
  });

  test("focus moves in on open and returns to the anchor on Escape", async () => {
    const onClose = mock((_reason: PopoverCloseReason) => {});
    const { anchor, handle } = mounted(onClose);
    await null; // the focus move-in lands on the next microtask
    expect(document.activeElement).toBe(handle.element);
    key(document, "Escape");
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(handle.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  test("an outside press dismisses it; a press on the anchor does not", () => {
    const onClose = mock((_reason: PopoverCloseReason) => {});
    const { anchor, handle } = mounted(onClose);
    press(anchor);
    expect(handle.element.isConnected).toBe(true);
    press(document.body);
    expect(onClose).toHaveBeenCalledWith("outside");
    expect(handle.element.isConnected).toBe(false);
  });

  test("focus moving away dismisses it without stealing focus back", async () => {
    const onClose = mock((_reason: PopoverCloseReason) => {});
    const { handle } = mounted(onClose);
    await null;
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    elsewhere.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(onClose).toHaveBeenCalledWith("blur");
    expect(handle.element.isConnected).toBe(false);
    // The writer put focus there; the closed surface does not pull it back.
    expect(document.activeElement).toBe(elsewhere);
  });

  test("destroy is silent teardown", () => {
    const onClose = mock((_reason: PopoverCloseReason) => {});
    const { handle } = mounted(onClose);
    handle.destroy();
    expect(onClose).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(false);
    // A destroyed popover no longer intercepts Escape.
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("Escape closes only the top surface, one at a time", async () => {
    const first = mounted();
    await null;
    // A surface nested inside the first, the way a menu opens over a popover:
    // its focus stays within the parent, so the parent stays open.
    const nested = popover({ anchor: first.anchor, content: "Nested" });
    first.handle.element.append(nested.element);
    await null;
    expect(document.activeElement).toBe(nested.element);
    key(document, "Escape");
    expect(nested.element.isConnected).toBe(false);
    expect(first.handle.element.isConnected).toBe(true);
    key(document, "Escape");
    expect(first.handle.element.isConnected).toBe(false);
  });
});

describe("tooltip", () => {
  function mounted(anchorAttrs: Record<string, string> = {}): { anchor: HTMLButtonElement; handle: ReturnType<typeof tooltip> } {
    const anchor = document.createElement("button");
    anchor.textContent = "Restore";
    for (const [k, v] of Object.entries(anchorAttrs)) anchor.setAttribute(k, v);
    document.body.append(anchor);
    const handle = tooltip({ anchor, text: "Restores this block to Maya’s version" });
    return { anchor, handle };
  }

  const tip = (): HTMLElement | null => document.querySelector('[role="tooltip"]');

  test("opens on hover and on focus, closing on leave and blur", () => {
    const { anchor, handle } = mounted();
    anchor.dispatchEvent(new Event("pointerenter"));
    const open = tip();
    expect(open).not.toBeNull();
    expect(open!.textContent).toBe("Restores this block to Maya’s version");
    expect(open!.classList.contains("nq-tooltip")).toBe(true);
    expect(anchor.getAttribute("aria-describedby")).toBe(open!.id);
    anchor.dispatchEvent(new Event("pointerleave"));
    expect(tip()).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);

    anchor.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(tip()).not.toBeNull();
    anchor.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(tip()).toBeNull();
    handle.destroy();
  });

  test("a tip that never took focus leaves it on the anchor through Escape", () => {
    const { anchor, handle } = mounted();
    anchor.focus();
    anchor.dispatchEvent(new Event("focusin", { bubbles: true }));
    const open = tip();
    expect(document.activeElement).toBe(anchor);
    key(document, "Escape");
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    handle.destroy();
  });

  test("restores an aria-describedby the anchor already had", () => {
    const { anchor, handle } = mounted({ "aria-describedby": "disabled-reason" });
    anchor.dispatchEvent(new Event("pointerenter"));
    expect(anchor.getAttribute("aria-describedby")).not.toBe("disabled-reason");
    anchor.dispatchEvent(new Event("pointerleave"));
    expect(anchor.getAttribute("aria-describedby")).toBe("disabled-reason");
    handle.destroy();
  });

  test("destroy removes the tip and the wiring", () => {
    const { anchor, handle } = mounted();
    handle.destroy();
    anchor.dispatchEvent(new Event("pointerenter"));
    expect(tip()).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
  });
});
