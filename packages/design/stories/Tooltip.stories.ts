import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, within } from "storybook/test";
import { button, tooltip } from "../src/index.ts";
import { el } from "../src/dom.ts";

function host(text: string): HTMLElement {
  const anchor = button({ label: "Restore" });
  tooltip({ anchor, text });
  return el(
    "div",
    { class: "sb-row" },
    anchor,
    el("span", { class: "nq-ui-body" }, "The rest of the toolbar row sits beside the control."),
  );
}

/** The tip mounts on document.body, outside the story canvas; query the document body. */
const tip = (): HTMLElement => within(document.body).getByRole("tooltip");

const meta = {
  title: "Components/Tooltip",
  parameters: {
    docs: {
      description: {
        component:
          "A hint for a single control, built on the popover primitive. Opens on pointer hover and on keyboard focus of the anchor, closes on leave, blur and Escape; while open, the anchor carries `aria-describedby` pointing at the tip, so screen readers reach what a `title` attribute hides from keyboard and touch writers (§9). The tip never takes focus. Use it wherever a disabled reason, change bar or shortcut needed a hint — one short sentence that names the thing, not the gesture.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const OnHover: Story = {
  render: () => host("Restores this block to Maya’s version"),
  play: async ({ canvas, userEvent }) => {
    const anchor = canvas.getByRole("button", { name: "Restore" });
    await userEvent.hover(anchor);
    const open = tip();
    await expect(open).toBeVisible();
    await expect(anchor).toHaveAttribute("aria-describedby", open.id);
    await userEvent.unhover(anchor);
    await expect(open).not.toBeInTheDocument();
    await expect(anchor).not.toHaveAttribute("aria-describedby");
  },
};

export const OnKeyboardFocus: Story = {
  render: () => host("Restores this block to Maya’s version"),
  play: async ({ canvas, userEvent }) => {
    const anchor = canvas.getByRole("button", { name: "Restore" });
    await userEvent.tab();
    await expect(anchor).toHaveFocus();
    const open = tip();
    await expect(open).toBeVisible();
    await expect(anchor).toHaveAttribute("aria-describedby", open.id);
    // The tip explains the control; focus never left it.
    await expect(anchor).toHaveFocus();
    // Escape closes without moving focus (§9).
    await userEvent.keyboard("{Escape}");
    await expect(open).not.toBeInTheDocument();
    await expect(anchor).toHaveFocus();
    await expect(anchor).not.toHaveAttribute("aria-describedby");
  },
};
