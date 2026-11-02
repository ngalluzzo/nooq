import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { loading, LOADING_DELAY, type LoadingHandle } from "../src/index.ts";

/**
 * The open state (foundation P2): the logo loader, only after the delay. The
 * windowed skeleton already covers scrolling; this is what a writer sees while
 * a document opens — nothing for a fast load, then the wordmark at loader
 * timing until the content is there.
 */

const handles = new WeakMap<HTMLElement, LoadingHandle>();

/** A positioned stage with room to center in — story-only framing; components never size themselves inline. */
function stage(delay?: number): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "sb-loading-stage";
  frame.style.position = "relative";
  frame.style.minHeight = "var(--nq-space-12)";
  const handle = loading(delay === undefined ? {} : { delay });
  frame.append(handle.element);
  handles.set(frame, handle);
  return frame;
}

const meta = {
  title: "Components/Loading",
  parameters: {
    docs: {
      description: {
        component:
          "The open state (foundation P2): nothing until the delay has elapsed — a load that finishes inside the window never shows anything — then the wordmark at `loader` timing, centered on paper, looping while shown. Loading is a brand surface, the one place the logo animation runs in the product (brand book, Motion); under `prefers-reduced-motion` the wordmark is at rest and never animates. While shown, the host carries `aria-busy` and the visually hidden word \"Loading\" (§9). The consumer mounts `element` in a positioned container the moment a load starts and calls `done()` when the content is there — the editor surface wires both halves (first render and `ready`). Do not use it for anything on the input path: it exists only before the first render (§3), and windowed skeletons, not the loader, cover scrolling.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** A load that outlives the window: the wordmark, then done() clears it. */
export const SlowOpen: Story = {
  render: () => stage(LOADING_DELAY),
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>(".sb-loading-stage")!;
    const host = await waitFor(() => {
      const element = frame.querySelector<HTMLElement>(".nq-loading")!;
      expect(element.getAttribute("aria-busy")).toBe("true");
      return element;
    });
    // The suite runs with reduced motion: the brand contract there is the
    // wordmark at rest, nothing moving. In a full-motion host the Move runs
    // at loader timing and loops.
    const logo = host.querySelector<SVGSVGElement>(".nq-logo")!;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await expect(logo.dataset.phase).toBe("rest");
    } else {
      // Full motion: the choreography is running (frame 0 draws before paint).
      await expect(logo.dataset.phase).not.toBe("rest");
    }
    await expect(host.querySelector(".nq-sr")?.textContent).toBe("Loading");
    // The load lands: the host leaves, and nothing of it stays behind.
    handles.get(frame)!.done();
    await expect(frame.querySelector(".nq-loading")).toBeNull();
  },
};

/** A fast load: done() inside the window, and nothing ever showed. */
export const FastOpen: Story = {
  render: () => {
    const frame = stage(LOADING_DELAY);
    // The load finished the moment it began — inside the window, before any
    // timer could fire, exactly as an instant local document does.
    handles.get(frame)!.done();
    return frame;
  },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>(".sb-loading-stage")!;
    const handle = handles.get(frame)!;
    await new Promise((resolve) => setTimeout(resolve, LOADING_DELAY + 100)); // outlive the window
    await expect(frame.querySelector(".nq-loading")).toBeNull(); // done() removed the host
    await expect(handle.element.querySelector(".nq-logo")).toBeNull(); // and nothing was ever drawn
    await expect(handle.element.getAttribute("aria-busy")).toBeNull();
  },
};
