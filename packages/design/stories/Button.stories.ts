import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { button, type ButtonProps } from "../src/index.ts";
import { row } from "./fixtures.ts";

const meta = {
  title: "Components/Button",
  render: (args) => button(args),
  args: { label: "Accept", variant: "default", onClick: fn() },
  argTypes: {
    variant: { control: "inline-radio", options: ["default", "primary", "quiet", "danger"] },
    label: { control: "text" },
    shortcut: { control: "text" },
    disabled: { control: "boolean" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "Actions in the chrome around the document. Label with the outcome (\"Accept\", \"Restore\"). At most one `primary` per card or dialog. `danger` only for what history cannot restore: deleting a block is a tombstone (DM-3.4), not a danger. Show `shortcut` for any action a writer repeats (§9).",
      },
    },
  },
} satisfies Meta<ButtonProps>;

export default meta;
type Story = StoryObj<ButtonProps>;

export const Primary: Story = {
  args: { variant: "primary", shortcut: "⌘↵" },
  play: async ({ args, canvas, userEvent }) => {
    const accept = canvas.getByRole("button", { name: /Accept/ });
    await expect(accept).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
    await userEvent.click(accept);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const Default: Story = { args: { label: "Accept anyway" } };
export const Quiet: Story = { args: { label: "Reject", variant: "quiet" } };
export const Danger: Story = { args: { label: "Delete document", variant: "danger" } };

export const Disabled: Story = {
  args: { variant: "primary", disabled: true },
  play: async ({ args, canvas, userEvent }) => {
    const b = canvas.getByRole("button", { name: "Accept" });
    await expect(b).toBeDisabled();
    await userEvent.click(b);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** Keyboard focus shows the focus ring: a paper gap, then solid ink (§9). */
export const KeyboardFocus: Story = {
  render: (args) => row(button({ ...args, variant: "primary", shortcut: "⌘↵" }), button({ ...args, label: "Reject", variant: "quiet" })),
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab();
    const accept = canvas.getByRole("button", { name: /Accept/ });
    await expect(accept).toHaveFocus();
    await expect(getComputedStyle(accept).boxShadow).toMatch(/rgb/);
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Reject" })).toHaveFocus();
  },
};
