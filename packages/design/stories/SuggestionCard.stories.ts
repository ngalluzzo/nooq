import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn, within } from "storybook/test";
import { button, suggestionCard, SUGGESTION_STATES, type SuggestionCardProps } from "../src/index.ts";
import { DIGESTS, grid, PILOT_DIFF } from "./fixtures.ts";

const meta = {
  title: "Components/SuggestionCard",
  render: (args) => suggestionCard(args),
  args: {
    state: "fresh",
    actor: "Rewrite assistant",
    model: "qwen3-8b",
    intent: "tighten-intro",
    diff: PILOT_DIFF,
    evidence: [
      { kind: "content", value: DIGESTS.content },
      { kind: "structure", value: DIGESTS.structure },
    ],
    acceptShortcut: "⌘↵",
    onAccept: fn(),
    onReject: fn(),
  },
  argTypes: {
    state: { control: "inline-radio", options: SUGGESTION_STATES },
    reason: { control: "text" },
    settledBy: { control: "text" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "An AI proposal (DM-6): the exact diff, who proposed it, its derived state, and the writer's decision. The diff renders the proposal's ops verbatim, because accepting applies them verbatim (DM-6.3). When not fresh, the writer may still accept: the button becomes \"Accept anyway\" at default weight and the card names the drift in one sentence. Accepted cards show both actors (DM-5 adoption provenance).",
      },
    },
  },
} satisfies Meta<SuggestionCardProps>;

export default meta;
type Story = StoryObj<SuggestionCardProps>;

export const Fresh: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole("article")).toHaveAccessibleName("Suggestion from Rewrite assistant, fresh");
    await userEvent.click(canvas.getByRole("button", { name: /^Accept/ }));
    await expect(args.onAccept).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole("button", { name: "Reject" }));
    await expect(args.onReject).toHaveBeenCalledTimes(1);
  },
};

export const Stale: Story = {
  args: {
    state: "stale",
    intent: "fix-tense",
    diff: [{ text: "Sync " }, { del: "will run" }, { ins: "runs" }, { text: " in the background." }],
    reason: "Maya edited this paragraph after the proposal was made.",
    evidence: [{ kind: "content", value: DIGESTS.stale }],
  },
  play: async ({ canvas }) => {
    const accept = canvas.getByRole("button", { name: "Accept anyway" });
    await expect(accept).not.toHaveClass("nq-btn-primary");
    await expect(canvas.getByText(/Maya edited this paragraph/)).toBeVisible();
  },
};

export const Conflicted: Story = {
  args: {
    state: "conflicted",
    actor: "Outline assistant",
    model: "llama-4-scout",
    intent: "merge-sections",
    diff: [{ ins: "Pricing and licensing" }],
    reason: "The target block was deleted.",
    evidence: [{ kind: "structure", value: DIGESTS.conflicted }],
  },
};

export const Accepted: Story = {
  args: { state: "accepted", settledBy: "Maya" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Proposed by qwen3-8b · accepted by Maya")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Accept/ })).toBeNull();
  },
};

export const Rejected: Story = { args: { state: "rejected", settledBy: "Maya" } };

/** Accept from the keyboard: Tab passes the two evidence digests, reaches Accept, and Enter adopts. */
export const KeyboardAccept: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: /^Accept/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onAccept).toHaveBeenCalledTimes(1);
  },
};

/**
 * DM-6.5: revalidation is continuous. When a concurrent edit invalidates the
 * evidence, the card degrades in place: same position, new tag, new outline.
 */
export const DegradesInPlace: Story = {
  render: (args) => {
    const wrap = document.createElement("div");
    wrap.className = "sb-stack";
    let card = suggestionCard(args);
    const edit = button({
      label: "Simulate Maya's edit",
      onClick: () => {
        const next = suggestionCard({ ...args, state: "stale", reason: "Maya edited this paragraph after the proposal was made." });
        card.replaceWith(next);
        card = next;
      },
    });
    wrap.append(card, edit);
    return wrap;
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("article")).toHaveAttribute("data-state", "fresh");
    await userEvent.click(canvas.getByRole("button", { name: "Simulate Maya's edit" }));
    const card = canvas.getByRole("article");
    await expect(card).toHaveAttribute("data-state", "stale");
    await expect(within(card).getByRole("button", { name: "Accept anyway" })).toBeVisible();
  },
};

export const AllStates: Story = {
  render: (args) =>
    grid(
      suggestionCard(args),
      suggestionCard({ ...args, ...Stale.args }),
      suggestionCard({ ...args, ...Conflicted.args }),
      suggestionCard({ ...args, ...Accepted.args }),
      suggestionCard({ ...args, ...Rejected.args }),
    ),
};
