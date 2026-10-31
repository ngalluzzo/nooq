import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, within } from "storybook/test";
import { blockRow, presenceCaret, suggestionCard, syncStatus, type SuggestionCardProps } from "../src/index.ts";
import { DIGESTS, PILOT_DIFF } from "./fixtures.ts";

/**
 * The whole idea in one flow: a writer reviews an AI proposal while a
 * colleague is in the document. Accepting inks the text in, and the block's
 * change bar records that an AI wrote it (DM-5).
 */
const meta = {
  title: "Patterns/Reviewing a proposal",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const proposal: SuggestionCardProps = {
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
};

const BEFORE = "The pilot ran for six weeks and most teams seemed to like it.";
const AFTER = "The pilot ran for six weeks across four teams; three kept using it after it ended.";

export const Review: Story = {
  render: () => {
    const page = document.createElement("div");
    const chrome = document.createElement("div");
    chrome.className = "sb-chrome";
    const title = document.createElement("span");
    title.className = "nq-ui-heading";
    title.textContent = "Q3 field notes";
    chrome.append(title, syncStatus({ state: "synced", count: 2 }));

    const layout = document.createElement("div");
    layout.className = "sb-review";
    const docEl = document.createElement("div");
    docEl.className = "nq-doc";

    const pilotWithProposal = () => blockRow({ content: [BEFORE.slice(0, 28), presenceCaret({ name: "Tomás", ink: "violet" }), BEFORE.slice(28)], ink: "teal", writer: "Tomás" });
    let pilot = pilotWithProposal();
    docEl.append(
      blockRow({ content: "Q3 field notes", kind: "title", writer: "Maya" }),
      blockRow({ content: "We shipped the offline mode to four teams in July. None of them noticed when the sync server went down for a day.", ink: "teal", writer: "Tomás" }),
      pilot,
    );

    const aside = document.createElement("aside");
    aside.setAttribute("aria-label", "Suggestions");
    const settle = (state: "accepted" | "rejected") => {
      card.replaceWith((card = suggestionCard({ ...proposal, state, settledBy: "Maya" })));
      if (state === "accepted") {
        const inked = blockRow({ content: AFTER, actor: "ai", writer: "Rewrite assistant (qwen3-8b), accepted by Maya" });
        pilot.replaceWith(inked);
        pilot = inked;
      }
    };
    let card = suggestionCard({ ...proposal, onAccept: () => settle("accepted"), onReject: () => settle("rejected") });
    aside.append(card);

    layout.append(docEl, aside);
    page.append(chrome, layout);
    return page;
  },
  play: async ({ canvas, userEvent }) => {
    const suggestions = within(canvas.getByRole("complementary", { name: "Suggestions" }));
    await userEvent.click(suggestions.getByRole("button", { name: /^Accept/ }));
    await expect(suggestions.getByText("Proposed by qwen3-8b · accepted by Maya")).toBeVisible();
    const inked = canvas.getByText(AFTER);
    await expect(inked).toBeVisible();
    // Inked in, but never unattributed: the change bar still says an AI wrote it.
    const row = inked.closest(".nq-block")!;
    await expect(row).toHaveAttribute("data-actor", "ai");
    await expect(within(row as HTMLElement).getByRole("img", { name: /Rewrite assistant \(qwen3-8b\), accepted by Maya/ })).toBeInTheDocument();
  },
};
