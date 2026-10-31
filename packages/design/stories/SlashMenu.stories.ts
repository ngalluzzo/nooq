import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { slashMenu, type SlashMenuProps } from "../src/index.ts";
import { MENU_ITEMS } from "./fixtures.ts";

const meta = {
  title: "Components/SlashMenu",
  render: (args) => slashMenu(args),
  args: { items: MENU_ITEMS, query: "", active: 1, onSelect: fn(), onClose: fn() },
  argTypes: { query: { control: "text" }, active: { control: { type: "number", min: 0, max: MENU_ITEMS.length - 1 } } },
  parameters: {
    docs: {
      description: {
        component:
          "The block insertion menu, opened by typing \"/\" in an empty block. Every registered block gets the same row with its type id, built-in or third-party (`acme.callout/v2`), per §7. Items that ask an AI for content use the hatched pencil glyph; their output arrives as a suggestion. Keyboard-complete (§9): arrows, Home, End, Enter, Escape.",
      },
    },
  },
} satisfies Meta<SlashMenuProps>;

export default meta;
type Story = StoryObj<SlashMenuProps>;

export const Open: Story = {
  play: async ({ canvas }) => {
    const options = canvas.getAllByRole("option");
    await expect(options).toHaveLength(MENU_ITEMS.length);
    await expect(options[1]).toHaveAttribute("aria-selected", "true");
    await expect(canvas.getByText("acme.callout/v2")).toBeVisible();
  },
};

export const Filtered: Story = { args: { query: "he", items: MENU_ITEMS.slice(1, 2), active: 0 } };

export const KeyboardSelect: Story = {
  args: { active: 0 },
  play: async ({ args, canvas, userEvent }) => {
    const listbox = canvas.getByRole("listbox", { name: "Insert block" });
    await userEvent.tab();
    await expect(listbox).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(canvas.getByRole("option", { name: /Two columns/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await expect(args.onSelect).toHaveBeenCalledWith(MENU_ITEMS[2], 2);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    await expect(canvas.getByRole("option", { name: /Draft with AI/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalledTimes(1);
  },
};

export const PointerSelect: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("option", { name: /Callout/ }));
    await expect(args.onSelect).toHaveBeenCalledWith(MENU_ITEMS[3], 3);
  },
};

export const Disabled: Story = {
  args: { active: 0, items: [
    { label: "Callout", type: "insert-callout", disabled: true, reason: "Callouts are unavailable here." },
    { label: "Text", type: "insert-text" },
  ] },
  play: async ({ args, canvas, userEvent }) => {
    const disabled = canvas.getByRole("option", { name: /Callout/ });
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(disabled);
    canvas.getByRole("listbox").focus(); await userEvent.keyboard("{Enter}");
    await expect(args.onSelect).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect(args.onSelect).toHaveBeenCalledWith(args.items[1], 1);
  },
};
