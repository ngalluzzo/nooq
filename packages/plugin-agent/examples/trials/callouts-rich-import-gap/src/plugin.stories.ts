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
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("A useful note");
    const toneValue = canvas.getByText("info");
    await expect(toneValue).toBeVisible();
    await userEvent.clear(textbox);
    await userEvent.type(textbox, "Edited in Storybook");
    await expect(textbox).toHaveTextContent("Edited in Storybook");
  },
};

export const Warning: Story = {
  args: { text: "Beware", fields: { tone: "warning" } },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("Beware");
    await expect(canvas.getByText("warning")).toBeVisible();
  },
};

export const Success: Story = {
  args: { text: "All good", fields: { tone: "success" } },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("All good");
    await expect(canvas.getByText("success")).toBeVisible();
  },
};

export const InvalidTone: Story = {
  args: { text: "Weird tone", fields: { tone: "unknown" } },
  play: async ({ canvas, userEvent }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("Weird tone");
    await expect(canvas.getByText("unknown")).toBeVisible();
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await userEvent.click(button);
    await expect(canvas.getByText("unknown")).toBeVisible();
    await expect(textbox).toHaveTextContent("Weird tone");
  },
};

export const KeyboardCycle: Story = {
  args: { text: "Keyboard target", fields: { tone: "info" } },
  play: async ({ canvas, userEvent }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("Keyboard target");
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("warning")).toBeVisible();
    await expect(canvas.queryByText("info")).not.toBeInTheDocument();
  },
};

export const NestedContent: Story = {
  args: { text: "Outer text", fields: { tone: "info" }, children: true },
  play: async ({ canvas }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("Outer text");
    const child = canvas.getByRole("textbox", { name: "Text block" });
    await expect(child).toHaveValue("Nested child");
  },
};

export const RichFormatting: Story = {
  args: { text: "bold demo", fields: { tone: "info" } },
  play: async ({ canvas, userEvent }) => {
    const textbox = canvas.getByRole("textbox", { name: "Callout text" });
    await expect(textbox).toHaveTextContent("bold demo");
    document.getSelection()?.selectAllChildren(textbox);
    await userEvent.keyboard("{Control>}b{/Control}");
    const strong = textbox.querySelector("strong");
    await expect(strong).toHaveTextContent("bold demo");
  },
};
