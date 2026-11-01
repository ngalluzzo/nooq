import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/editor/testing";
import plugin from "./index.ts";
import dom from "./dom.ts";
const meta = {
  title: "Plugins/seed.callouts",
  render: (args) => mountPluginStory(plugin, dom, args),
  beforeEach: () => () => disposePluginStories(),
  args: { text: "A useful note", fields: {"tone":"info"} },
} satisfies Meta<PluginStoryArgs>;
export default meta;
type Story = StoryObj<PluginStoryArgs>;
// Implement every story named in the brief, with meaningful awaited play assertions.
export const Default: Story = { play: async ({ canvas }) => {
  await expect(canvas.getByRole("textbox", { name: "Callout text" })).toHaveValue("A useful note");
} };
