import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { actorChip, PEER_INKS, type ActorChipProps } from "../src/index.ts";
import { row } from "./fixtures.ts";

const meta = {
  title: "Components/ActorChip",
  render: (args) => actorChip(args),
  args: { kind: "human", name: "Maya", ink: "self" },
  argTypes: {
    kind: { control: "inline-radio", options: ["human", "ai", "importer", "migration", "system"] },
    ink: { control: "select", options: ["self", ...PEER_INKS] },
    model: { control: "text" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "Names who or what made a change (DM-5). People show a solid mark in their ink and their name. Everyone else shows their kind as a word, so an AI is never mistaken for a person by color alone. AI actors always name their model (§5).",
      },
    },
  },
} satisfies Meta<ActorChipProps>;

export default meta;
type Story = StoryObj<ActorChipProps>;

export const LocalWriter: Story = {};
export const RemoteWriter: Story = { args: { name: "Tomás", ink: "violet" } };
export const AI: Story = { args: { kind: "ai", name: "Rewrite assistant", model: "qwen3-8b" } };

export const EveryKind: Story = {
  render: () =>
    row(
      actorChip({ name: "Maya" }),
      actorChip({ name: "Tomás", ink: "violet" }),
      actorChip({ kind: "ai", name: "Rewrite assistant", model: "qwen3-8b" }),
      actorChip({ kind: "importer", name: "Docx importer" }),
      actorChip({ kind: "migration", name: "nooq.heading v1→v2" }),
      actorChip({ kind: "system", name: "Normalizer" }),
    ),
  play: async ({ canvas }) => {
    for (const word of ["AI", "Importer", "Migration", "System"]) await expect(canvas.getByText(word, { exact: true })).toBeVisible();
    await expect(canvas.getByText("qwen3-8b")).toBeVisible();
  },
};

/** The six remote inks. The peer ink for a writer comes from peerInk(actorId). */
export const PeerInks: Story = {
  render: () => row(...PEER_INKS.map((ink) => actorChip({ name: ink, ink }))),
};
