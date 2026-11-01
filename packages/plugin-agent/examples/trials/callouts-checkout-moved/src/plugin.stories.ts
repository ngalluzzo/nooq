import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, userEvent } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/editor/testing";
import plugin from "./index.ts";
import dom from "./dom.ts";

const meta = {
  title: "Plugins/seed.callouts",
  render: (args: PluginStoryArgs) => mountPluginStory(plugin, dom, args),
  beforeEach: () => () => disposePluginStories(),
  args: { text: "A useful note", fields: { tone: "info" } },
} satisfies Meta<PluginStoryArgs>;

export default meta;
type Story = StoryObj<PluginStoryArgs>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveValue("A useful note");
    await expect(canvas.getByText("info")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeInTheDocument();
  },
};

export const Warning: Story = {
  args: { fields: { tone: "warning" }, text: "Watch out" },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveValue("Watch out");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeInTheDocument();
  },
};

export const Success: Story = {
  args: { fields: { tone: "success" }, text: "All good" },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveValue("All good");
    await expect(canvas.getByText("success")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeInTheDocument();
  },
};

export const InvalidTone: Story = {
  args: { fields: { tone: "unknown" }, text: "Something odd" },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveValue("Something odd");
    // Invalid tone must still be displayed
    await expect(canvas.getByText("unknown")).toBeInTheDocument();
    // The cycle button is still present but should not change the tone when clicked
    const cycleBtn = canvas.getByRole("button", { name: "Cycle callout tone" });
    await expect(cycleBtn).toBeInTheDocument();
    await userEvent.click(cycleBtn);
    // Tone should remain "unknown" (command declined)
    await expect(canvas.getByText("unknown")).toBeInTheDocument();
  },
};

export const KeyboardCycle: Story = {
  play: async ({ canvas }) => {
    const cycleBtn = canvas.getByRole("button", { name: "Cycle callout tone" });
    await expect(cycleBtn).toHaveFocus();
    // Cycle from info → warning
    await userEvent.keyboard(" ");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    // Cycle from warning → success
    await userEvent.keyboard(" ");
    await expect(canvas.getByText("success")).toBeInTheDocument();
    // Cycle from success → info
    await userEvent.keyboard(" ");
    await expect(canvas.getByText("info")).toBeInTheDocument();
  },
};

export const NestedContent: Story = {
  args: { children: true },
  play: async ({ canvas }) => {
    // The parent callout textbox
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toBeInTheDocument();
    // The nested child should be visible
    await expect(canvas.getByText("Nested child")).toBeInTheDocument();
  },
};
