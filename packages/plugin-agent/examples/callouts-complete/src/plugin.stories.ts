import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/plugin-agent/storybook";
import plugin from "./index.ts";
import dom from "./dom.ts";

const meta = {
  title: "Plugins/seed.callouts",
  render: (args) => mountPluginStory(plugin, dom, args),
  beforeEach: () => () => disposePluginStories(),
  args: { text: "A useful note", fields: { tone: "info" } },
} satisfies Meta<PluginStoryArgs>;

export default meta;
type Story = StoryObj<PluginStoryArgs>;

export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveValue("A useful note");
    const tone = canvas.getByText("info");
    await expect(tone).toBeInTheDocument();
    await userEvent.clear(text);
    await userEvent.type(text, "Edited in Storybook");
    await expect(text).toHaveValue("Edited in Storybook");
  },
};

export const Warning: Story = {
  args: { text: "Heads up", fields: { tone: "warning" } },
  play: async ({ canvas }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveValue("Heads up");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeInTheDocument();
  },
};

export const Success: Story = {
  args: { text: "All good", fields: { tone: "success" } },
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveValue("All good");
    await expect(canvas.getByText("success")).toBeInTheDocument();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await userEvent.click(button);
    await expect(canvas.getByText("info")).toBeInTheDocument();
    await expect(canvas.queryByText("success")).toBeNull();
  },
};

export const InvalidTone: Story = {
  args: { text: "Something odd", fields: { tone: "unknown" } },
  play: async ({ canvas, userEvent }) => {
    const tone = canvas.getByText("unknown");
    await expect(tone).toBeInTheDocument();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await userEvent.click(button);
    await expect(canvas.getByText("unknown")).toBeInTheDocument();
    await expect(canvas.queryByText("info")).toBeNull();
    await expect(canvas.queryByText("warning")).toBeNull();
  },
};

export const KeyboardCycle: Story = {
  play: async ({ canvas, userEvent }) => {
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    button.focus();
    await expect(button).toHaveFocus();
    await expect(canvas.getByText("info")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    await expect(canvas.queryByText("info")).toBeNull();
  },
};

export const NestedContent: Story = {
  args: { children: true },
  play: async ({ canvas }) => {
    const nested = canvas.getByRole("textbox", { name: "Text block" });
    await expect(nested).toHaveValue("Nested child");
    const ownText = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(ownText).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeInTheDocument();
  },
};
