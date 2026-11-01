import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/editor/testing";
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
    await expect(text).toHaveTextContent("A useful note");
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeEnabled();
    await expect(canvas.getByText("info")).toBeInTheDocument();
    await userEvent.clear(text);
    await userEvent.type(text, "Edited in Storybook");
    await expect(text).toHaveTextContent("Edited in Storybook");
  },
};

export const Warning: Story = {
  args: { fields: { tone: "warning" } },
  play: async ({ canvas }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeEnabled();
  },
};

export const Success: Story = {
  args: { fields: { tone: "success" } },
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    await expect(canvas.getByText("success")).toBeInTheDocument();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await expect(button).toBeEnabled();
    await userEvent.click(button);
    await expect(canvas.getByText("info")).toBeInTheDocument();
    await expect(canvas.queryByText("success")).not.toBeInTheDocument();
  },
};

export const InvalidTone: Story = {
  args: { fields: { tone: "unknown" } },
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    await expect(canvas.getByText("unknown")).toBeInTheDocument();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await userEvent.click(button);
    await expect(canvas.getByText("unknown")).toBeInTheDocument();
    await expect(canvas.queryByText("warning")).not.toBeInTheDocument();
    await expect(canvas.queryByText("info")).not.toBeInTheDocument();
  },
};

export const KeyboardCycle: Story = {
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    await expect(canvas.getByText("info")).toBeInTheDocument();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("warning")).toBeInTheDocument();
    await expect(canvas.queryByText("info")).not.toBeInTheDocument();
    button.focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("success")).toBeInTheDocument();
    await expect(canvas.queryByText("warning")).not.toBeInTheDocument();
  },
};

export const NestedContent: Story = {
  args: { children: true },
  play: async ({ canvas }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    const nested = canvas.getByRole("textbox", { name: "Text block" });
    await expect(nested).toHaveValue("Nested child");
  },
};

export const RichFormatting: Story = {
  play: async ({ canvas, userEvent }) => {
    const text = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(text).toHaveTextContent("A useful note");
    text.focus();
    const selection = document.getSelection();
    if (selection) selection.selectAllChildren(text);
    await userEvent.keyboard("{Control>}b{/Control}");
    const strong = text.querySelector("strong");
    await expect(strong).not.toBeNull();
    await expect(strong).toHaveTextContent("A useful note");
  },
};
