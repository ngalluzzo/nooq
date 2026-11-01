import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every story runs in real Chromium once per theme: its play function, plus
 * an axe check (a11y.test = "error") against that theme's colors.
 * Unit tests run under `bun test`, not here.
 */
export default defineConfig({
  // Editor-backed stories load these transitively; prebundle before either theme starts.
  optimizeDeps: { include: [
    "@nooq/plugin-agent > @nooq/editor > prosemirror-model",
    "@nooq/plugin-agent > @nooq/editor > prosemirror-state",
    "@nooq/plugin-agent > @nooq/editor > prosemirror-view",
  ] },
  test: {
    projects: (["light", "dark"] as const).map((theme) => ({
      extends: true,
      plugins: [storybookTest({ configDir: path.join(dirname, ".storybook"), initialGlobals: { theme } })],
      test: {
        name: `stories:${theme}`,
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({
            // Stories assert the resting state directly after mount: run with
            // reduced motion so entrance animations (the 80ms fade) never race
            // a play function. Real hosts see the fade (§3).
            contextOptions: { reducedMotion: "reduce" },
          }),
          instances: [{ browser: "chromium" as const }],
        },
      },
    })),
  },
});
