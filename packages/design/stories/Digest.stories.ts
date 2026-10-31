import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { digest, type DigestProps } from "../src/index.ts";
import { DIGESTS, row } from "./fixtures.ts";

const meta = {
  title: "Components/Digest",
  render: (args) => digest(args),
  args: { value: DIGESTS.content, kind: "content", copy: fn() },
  argTypes: { kind: { control: "text" }, value: { control: "text" } },
  parameters: {
    docs: {
      description: {
        component:
          "A DM-2 fingerprint, shown as the first 6 and last 4 hex digits. Clicking copies the full value; the full value is also the tooltip and the accessible name. Show digests where a reviewer compares exact state: evidence, snapshots, debug views. Not on the writing surface.",
      },
    },
  },
} satisfies Meta<DigestProps>;

export default meta;
type Story = StoryObj<DigestProps>;

export const Content: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const chip = canvas.getByRole("button", { name: "content sha256:177298…cfd7 (copy full value)" });
    await expect(chip).toHaveAccessibleDescription(DIGESTS.content);
    await userEvent.click(chip);
    await expect(args.copy).toHaveBeenCalledWith(DIGESTS.content);
  },
};

export const WithoutKind: Story = { args: { value: DIGESTS.block, kind: undefined } };

export const Evidence: Story = {
  render: (args) => row(digest({ ...args, kind: "content", value: DIGESTS.content }), digest({ ...args, kind: "structure", value: DIGESTS.structure })),
};

/** Copying works from the keyboard too. */
export const KeyboardCopy: Story = {
  play: async ({ args, userEvent }) => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect(args.copy).toHaveBeenCalledWith(DIGESTS.content);
  },
};
