import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn, waitFor } from "storybook/test";
import { button, popover, type PopoverCloseReason, type PopoverHandle, type PopoverSide } from "../src/index.ts";
import { el } from "../src/dom.ts";

/** What sits in the popover here: the block-history panel that will mount on it (0005). */
function historyPanel(onRestore: () => void): HTMLElement {
  return el(
    "div",
    { class: "sb-stack" },
    el("div", { class: "nq-ui-label" }, "Block history"),
    el("div", { class: "nq-ui-body" }, "Maya rewrote the opening sentence · 14:02"),
    el("div", { class: "nq-ui-body" }, "Imported from draft.docx · yesterday"),
    button({ label: "Restore", onClick: onRestore }),
  );
}

interface AnchoredOptions {
  side?: PopoverSide;
  /** Story-only anchor placement (inline styles never ship in components). */
  place?: (anchor: HTMLButtonElement) => void;
  onClose?: (reason: PopoverCloseReason) => void;
}

/** A trigger wired the way a consumer wires it: click toggles one popover. */
function anchored(label: string, options: AnchoredOptions = {}): HTMLElement {
  const { side = "bottom", place, onClose } = options;
  let open: PopoverHandle | null = null;
  const anchor = button({
    label,
    onClick: () => {
      if (open) {
        open.destroy();
        open = null;
        return;
      }
      open = popover({ anchor, side, content: historyPanel(onRestore), onClose });
      host.append(open.element);
    },
  });
  place?.(anchor);
  const onRestore = fn();
  const host = el(
    "div",
    { class: "sb-stack" },
    el("div", { class: "sb-row" }, anchor),
    el("p", { class: "sb-prose nq-doc-body" }, "The document continues beneath the anchor, the way a real surface would sit under it."),
  );
  return host;
}

const surface = (canvasElement: HTMLElement): HTMLElement => canvasElement.querySelector<HTMLElement>(".nq-popover")!;

const meta = {
  title: "Components/Popover",
  parameters: {
    docs: {
      description: {
        component:
          "One anchored, non-modal surface. The slash menu, toolbar overflow, link editing and block history all sit on it: pass an anchor and content, append `element` in the same tick, and it places itself — flip and shift computed from `getBoundingClientRect` against the viewport, no dependencies. Escape, an outside press, or focus moving away dismiss it, and focus returns to the anchor (give a non-control anchor a `tabindex`). Never modal, never a dialog: destructive confirmation is a later Dialog built on this focus handling.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Anchored: Story = {
  render: () => anchored("Block history", { onClose: fn() }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const anchor = canvas.getByRole("button", { name: "Block history" });
    // Keyboard-complete (§9): open without a pointer.
    await userEvent.tab();
    await expect(anchor).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const open = surface(canvasElement);
    await expect(open).toBeInTheDocument();
    // Focus moved in, and the surface says where it put itself.
    await waitFor(() => expect(open).toHaveFocus());
    await expect(open).toHaveAttribute("data-side", "bottom");
    // Escape dismisses it and returns focus to the anchor.
    await userEvent.keyboard("{Escape}");
    await expect(open).not.toBeInTheDocument();
    await expect(anchor).toHaveFocus();
  },
};

export const OutsidePressCloses: Story = {
  render: () => anchored("Block history", { onClose: fn() }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Block history" }));
    const open = surface(canvasElement);
    await expect(open).toBeInTheDocument();
    await userEvent.click(canvas.getByText(/document continues beneath/));
    await expect(open).not.toBeInTheDocument();
  },
};

/** Near the bottom edge, the preferred bottom side flips to top. */
export const FlipsAtEdge: Story = {
  render: () =>
    anchored("Block history", {
      side: "bottom",
      place: (anchor) => {
        anchor.style.position = "fixed";
        anchor.style.right = "var(--nq-space-6)";
        anchor.style.bottom = "var(--nq-space-6)";
      },
    }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const anchor = canvas.getByRole("button", { name: "Block history" });
    await userEvent.click(anchor);
    const open = surface(canvasElement);
    await expect(open).toHaveAttribute("data-flipped", "true");
    await expect(open).toHaveAttribute("data-side", "top");
    // It sits above the anchor, clear of the viewport edge.
    expect(open.getBoundingClientRect().bottom).toBeLessThanOrEqual(anchor.getBoundingClientRect().top);
  },
};

/** Near the right edge, the cross axis shifts so nothing leaves the viewport. */
export const ShiftsAtEdge: Story = {
  render: () =>
    anchored("Block history", {
      side: "bottom",
      place: (anchor) => {
        anchor.style.position = "fixed";
        anchor.style.right = "var(--nq-space-2)";
        anchor.style.top = "50%";
      },
    }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Block history" }));
    const open = surface(canvasElement);
    await expect(open).toHaveAttribute("data-side", "bottom");
    const rect = open.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.left).toBeGreaterThanOrEqual(0);
  },
};
