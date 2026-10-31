import { defineMain } from "@storybook/html-vite/node";

export default defineMain({
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.ts", "../../plugin-agent/examples/callouts-complete/src/plugin.stories.ts",
    { directory: "../../plugin-agent/examples/callouts-rich/src", files: "plugin.stories.ts", titlePrefix: "Rich text" },
  ],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: { name: "@storybook/html-vite", options: {} },
  core: { disableTelemetry: true },
});
