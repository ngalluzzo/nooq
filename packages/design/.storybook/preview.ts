import type { Preview } from "@storybook/html-vite";
import "../src/fonts.css";
import "../src/tokens.css";
import "../src/nooq.css";
import "./preview.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "nooq theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (story, context) => {
      const theme = String(context.globals.theme ?? "light");
      // Canvas mode: theme the whole page. Docs mode: each story carries its own surface.
      if (context.viewMode === "story") {
        document.documentElement.setAttribute("data-nq-theme", theme);
        document.body.classList.add("nq-surface");
      }
      const frame = document.createElement("div");
      frame.className = "nq-surface sb-frame";
      frame.setAttribute("data-nq-theme", theme);
      const rendered = story();
      if (typeof rendered === "string") frame.innerHTML = rendered;
      else frame.append(rendered);
      return frame;
    },
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    // Every story is an accessibility test: violations fail `vitest run` in both themes.
    a11y: {
      test: "error",
      // Page-level rules judge a whole document, not a component in isolation.
      config: { rules: [{ id: "page-has-heading-one", enabled: false }, { id: "landmark-one-main", enabled: false }, { id: "region", enabled: false }] },
    },
    options: {
      storySort: { order: ["Introduction", "Foundations", ["Color", "Typography", "Space and shape", "Themes"], "Brand", "Protocol surfaces", "Components", "Patterns"] },
    },
  },
  tags: ["autodocs"],
};

export default preview;
