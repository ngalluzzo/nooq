import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { stateTag, SUGGESTION_STATES, type StateTagProps } from "../src/index.ts";
import { row } from "./fixtures.ts";

const meta = {
  title: "Components/StateTag",
  render: (args) => stateTag(args),
  args: { state: "fresh" },
  argTypes: { state: { control: "inline-radio", options: SUGGESTION_STATES } },
  parameters: {
    docs: {
      description: {
        component:
          "A suggestion's DM-6.2 state as a word, a glyph and a fill, so nothing depends on color alone (§9). Pass what `evaluate()` returned just now; never store it. When it changes, swap the tag in place: no toast, no animation.",
      },
    },
  },
} satisfies Meta<StateTagProps>;

export default meta;
type Story = StoryObj<StateTagProps>;

export const Fresh: Story = {};
export const Stale: Story = { args: { state: "stale" } };
export const Conflicted: Story = { args: { state: "conflicted" } };

export const AllStates: Story = {
  render: () => row(...SUGGESTION_STATES.map((state) => stateTag({ state }))),
  play: async ({ canvas, canvasElement }) => {
    for (const state of SUGGESTION_STATES) await expect(canvas.getByText(state, { exact: true })).toBeVisible();
    // Three channels: each state also has its own glyph.
    const glyphs = Array.from(canvasElement.querySelectorAll(".nq-state svg")).map((g) => g.innerHTML);
    await expect(new Set(glyphs).size).toBe(SUGGESTION_STATES.length);
  },
};
