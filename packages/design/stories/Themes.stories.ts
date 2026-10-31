import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { blockRow, caret, resolveColor, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/** "#2343d1" → "rgb(35, 67, 209)", as getComputedStyle reports it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function surface(theme: "light" | "dark", label: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "nq-surface sb-frame";
  section.setAttribute("data-nq-theme", theme);
  section.setAttribute("aria-label", label);
  section.append(blockRow({ content: ["Offline is the default state", caret()], writer: "Maya" }));
  return section;
}

const meta = {
  title: "Foundations/Themes",
  parameters: {
    docs: {
      description: {
        component:
          'Light is the default. `data-nq-theme="dark"` switches any subtree, and `data-nq-theme="system"` follows the OS. Themes nest: a dark panel inside a light page gets dark aliases too, because every theme block redeclares them.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Nested: Story = {
  render: () => {
    const wrap = document.createElement("div");
    wrap.className = "sb-stack";
    wrap.append(surface("light", "Light surface"), surface("dark", "Dark surface"));
    return wrap;
  },
  play: async ({ canvas, canvasElement, globals }) => {
    // The story frame follows the toolbar theme; Vitest runs it once per theme.
    const theme = globals.theme === "dark" ? "dark" : "light";
    const frame = canvasElement.querySelector(".sb-frame")!;
    await expect(getComputedStyle(frame).backgroundColor).toBe(rgb(resolveColor(tokens, "paper", theme)));
    // Each nested surface resolves its own aliases: caret → ink of that theme.
    for (const t of ["light", "dark"] as const) {
      const section = canvas.getByRole("region", { name: `${t === "light" ? "Light" : "Dark"} surface` });
      await expect(getComputedStyle(section).backgroundColor).toBe(rgb(resolveColor(tokens, "paper", t)));
      await expect(getComputedStyle(section.querySelector(".nq-caret")!).backgroundColor).toBe(rgb(resolveColor(tokens, "caret", t)));
    }
  },
};
