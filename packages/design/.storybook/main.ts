import { defineMain } from "@storybook/html-vite/node";

export default defineMain({
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.ts", "../../plugin-agent/examples/callouts-complete/src/plugin.stories.ts"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: { name: "@storybook/html-vite", options: {} },
  core: { disableTelemetry: true },
});
