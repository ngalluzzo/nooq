import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { el } from "../src/dom.ts";
import { blockContainer, button, CONTAINER_TONES, setBlockContainerTone, type ContainerTone } from "../src/index.ts";
import { row } from "./fixtures.ts";

type Args = { tone?: ContainerTone; onCopy: () => void };

/** One container as a plugin view would mount it: text host, nested child, controls. */
function demo(tone: ContainerTone | undefined, onCopy: () => void) {
  return blockContainer({
    label: "Callout",
    tone,
    state: el("span", { role: "status" }, "Tone: info"),
    body: el("p", { class: "nq-doc-body" }, "Source ships every Friday at 16:00 UTC; subscribers get the digest first."),
    children: el("div", { class: "nq-children" }, el("p", { class: "nq-doc-body" }, "A nested paragraph.")),
    controls: button({ label: "Copy schedule", variant: "quiet", onClick: onCopy }),
  });
}

const meta = {
  title: "Components/BlockContainer",
  render: (args) => demo(args.tone, args.onCopy),
  args: { tone: "neutral", onCopy: fn() },
  argTypes: { tone: { control: "inline-radio", options: CONTAINER_TONES } },
  parameters: {
    docs: {
      description: {
        component:
          "The frame every plugin block sits in, styled exactly like a built-in (§7): a header with the label word and a state slot, a body slot for the host's text binding, a children slot and a controls slot. The consumer provides the slots and never sets a color, border or spacing itself. A tone is always also a word in the header (§9): use `ink` for settled human outcomes, `pencil` only for AI-made content, `stamp` only when structure broke — hue means an actor, so severity never tints a frame. Not for chrome that floats over the document (menus, popovers) or inline notices on the error channel.",
      },
    },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Neutral: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Callout", { exact: true })).toBeVisible();
    await expect(canvas.getByText("neutral", { exact: true })).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("Tone: info");
  },
};

/** A settled human outcome: accepted, signed-off, done. */
export const Ink: Story = { args: { tone: "ink" } };

/** Reserved for AI-made content (§5): the word and the dashed outline say who wrote it. */
export const Pencil: Story = { args: { tone: "pencil" } };

/** Reserved for structural problems (DM-6.2): the frame only goes red when structure broke. */
export const Stamp: Story = { args: { tone: "stamp" } };

/** No tone: an untoned resting frame, and no tone word. */
export const Resting: Story = {
  args: { tone: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Callout", { exact: true })).toBeVisible();
    await expect(canvasElement.querySelector(".nq-block-container-tone")).toBeNull();
  },
};

/** The tone changes in place: same frame, new word and ground, no animation (§3). */
export const ToneChangesInPlace: Story = {
  render: (args) => {
    const container = demo("neutral", args.onCopy);
    container.append(
      button({
        label: "Show as AI-made",
        onClick: () => setBlockContainerTone(container, "pencil"),
      }),
    );
    return container;
  },
  play: async ({ canvas, userEvent }) => {
    const container = canvas.getByRole("button", { name: "Copy schedule" }).closest(".nq-block-container")!;
    await expect(container).toHaveAttribute("data-tone", "neutral");
    await userEvent.click(canvas.getByRole("button", { name: "Show as AI-made" }));
    await expect(container).toHaveAttribute("data-tone", "pencil");
    await expect(container.querySelector(".nq-block-container-tone")?.textContent).toBe("pencil");
  },
};

/** Controls are keyboard-reachable: Tab reaches the toolbar, Enter runs it (§9). */
export const KeyboardControls: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const action = canvas.getByRole("button", { name: "Copy schedule" });
    await userEvent.tab();
    await expect(action).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onCopy).toHaveBeenCalledTimes(1);
  },
};

export const AllTones: Story = {
  render: (args) => row(...CONTAINER_TONES.map((tone) => demo(tone, args.onCopy))),
  play: async ({ canvas }) => {
    for (const tone of CONTAINER_TONES) await expect(canvas.getByText(tone, { exact: true })).toBeVisible();
  },
};
