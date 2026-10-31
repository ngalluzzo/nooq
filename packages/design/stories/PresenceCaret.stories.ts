import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { caret, PEER_INKS, presenceCaret, type PresenceCaretProps } from "../src/index.ts";

function prose(...children: (Node | string)[]): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "nq-doc-body sb-prose";
  p.append(...children);
  return p;
}

const meta = {
  title: "Components/PresenceCaret",
  render: (args) => prose("Sync is a background concern the writer never waits on. ", presenceCaret(args), " from the first commit."),
  args: { name: "Tomás", ink: "violet", selection: "Every feature works in airplane mode" },
  argTypes: { ink: { control: "select", options: PEER_INKS }, selection: { control: "text" } },
  parameters: {
    docs: {
      description: {
        component:
          "A remote writer's caret, name flag and selection, inline in text. The ink comes from `peerInk(actorId)`. The flag always shows, because two writers can derive the same ink. Render presence in an overlay layer: it never reflows the local writer's text or delays their caret (§3). The local caret is `caret()`.",
      },
    },
  },
} satisfies Meta<PresenceCaretProps>;

export default meta;
type Story = StoryObj<PresenceCaretProps>;

export const WithSelection: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Tomás’s cursor")).toBeInTheDocument();
    await expect(canvas.getByText("Every feature works in airplane mode")).toBeVisible();
  },
};

export const CaretOnly: Story = { args: { selection: undefined, name: "Ines", ink: "green" } };

export const SeveralWriters: Story = {
  render: () =>
    prose(
      "Sync is a background concern the writer never waits on. ",
      presenceCaret({ name: "Tomás", ink: "violet", selection: "Every feature works in airplane mode" }),
      " from the first commit, and the network ",
      presenceCaret({ name: "Ines", ink: "green" }),
      "is an optimization",
      caret(),
      ".",
    ),
};
