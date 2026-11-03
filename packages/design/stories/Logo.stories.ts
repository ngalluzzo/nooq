import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { logoAssets } from "../src/brand/assets.ts";
import { animateWordmark, button, logoFrame, mark, renderWordmarkFrame, TIMINGS, wordmark, type TimingName, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

function stage(width: number, ...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "sb-logo-stage";
  div.style.width = `${width}px`;
  div.append(...children);
  return div;
}

function player(timing: TimingName, autoplay: boolean): HTMLDivElement {
  const logo = wordmark();
  const play = () => animateWordmark(logo, { timing });
  const controls = document.createElement("div");
  controls.className = "sb-row";
  controls.append(button({ label: "Play", onClick: () => void play() }));
  const wrap = document.createElement("div");
  wrap.className = "sb-stack";
  wrap.append(controls, stage(360, logo));
  if (autoplay) requestAnimationFrame(() => void play());
  return wrap;
}

const meta = {
  title: "Brand/Logo",
  // Documented by Logo.mdx instead of autodocs.
  tags: ["!autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The base of the first o peels away, straightens beneath the baseline and curves upright into the q’s tail. The stroke keeps its length. Ink spreads around the bowl from the join as the corners tighten.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Wordmark: Story = {
  render: () => stage(360, wordmark()),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("img", { name: "nooq" })).toBeInTheDocument();
    await expect(canvasElement.querySelector(".nq-logo")).toHaveAttribute("data-phase", "rest");
    await expect(canvasElement.querySelector(".nq-logo-letter.is-ink")).toHaveAttribute("stroke-width", "20");
  },
};

/** One ink, taken from CSS `color`: print, embossing, single-color contexts. */
export const Mono: Story = { render: () => stage(360, wordmark({ mono: true })) };

/** The mark: collapse the wordmark and the q is what remains. */
export const Mark: Story = { render: () => stage(72, mark()) };

/** assets/nooq-icon.svg: the mark on a paper tile, for favicons and app icons. */
export const AppIcon: Story = {
  render: () => {
    const div = document.createElement("div");
    div.className = "sb-row";
    for (const size of [128, 64, 32, 16]) {
      const tile = document.createElement("div");
      tile.style.width = tile.style.height = `${size}px`;
      tile.innerHTML = logoAssets(tokens)["nooq-icon.svg"]!;
      div.append(tile);
    }
    return div;
  },
};

/** For the site and first run. Plays on load. */
export const Hero: Story = { render: () => player("hero", true) };

/** The same choreography at loader speed. */
export const Loader: Story = {
  render: () => player("loader", false),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const logo = canvasElement.querySelector<SVGSVGElement>(".nq-logo")!;
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // The story suite runs with reduced motion; the brand contract then is
      // the wordmark at rest and nothing moving (§Motion). The choreography
      // itself is covered by logo.test.ts and the Frame story.
      await expect(logo.dataset.phase).toBe("rest");
      return;
    }
    await expect(logo.dataset.phase).not.toBe("rest");
    await waitFor(() => expect(logo.dataset.phase).toBe("travel"), { timeout: 2000 });
    await waitFor(() => expect(logo.dataset.phase).toBe("rest"), { timeout: 2000 });
    await expect(logo.querySelector(".nq-logo-piece")).toHaveClass("is-moved");
  },
};

interface ScrubArgs {
  ms: number;
  timing: TimingName;
}

/** Any frame, for review. Drag `ms`. */
export const Frame: StoryObj<ScrubArgs> = {
  args: { ms: 1100, timing: "hero" },
  argTypes: {
    ms: { control: { type: "range", min: 0, max: TIMINGS.hero.total, step: 10 } },
    timing: { control: "inline-radio", options: Object.keys(TIMINGS) },
  },
  render: ({ ms, timing }) => {
    const logo = wordmark();
    renderWordmarkFrame(logo, logoFrame(ms, TIMINGS[timing]));
    return stage(360, logo);
  },
  play: async ({ args, canvasElement }) => {
    await expect(canvasElement.querySelector(".nq-logo")).toHaveAttribute("data-phase", logoFrame(args.ms, TIMINGS[args.timing]).phase);
  },
};
