import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { ANNOUNCE_QUIET, announcer, type Announcer } from "../src/index.ts";
import { row } from "./fixtures.ts";

let handle: Announcer | undefined;

const meta = {
  title: "Components/Announcer",
  render: () => {
    handle = announcer();
    return row(handle.element);
  },
  parameters: {
    docs: {
      description: {
        component:
          "One persistent polite live region for semantic events: \"Tomás joined.\", \"Suggestion is now stale.\" Rate-limited to one announcement per 750ms — a message inside the quiet window replaces any pending one, so bursts drop intermediates and the latest wins. Callers pass semantic events only, never per keystroke (§9). Mount `element` once and never replace it: a region recreated per message is a region assistive tech never reads.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

/** The quiet window, measured with the story's own announcer. */
const quietPasses = () => new Promise<void>(resolve => setTimeout(resolve, ANNOUNCE_QUIET + 250));

export const JoinsAndLeaves: Story = {
  play: async () => {
    const a = handle!;
    a.say("Tomás joined.");
    expect(a.element.textContent).toBe("Tomás joined."); // the first message speaks immediately
    a.say("Maya joined.");
    a.say("Tomás left.");
    expect(a.element.textContent).toBe("Tomás joined."); // inside the quiet window: nothing churns yet
    await waitFor(() => expect(a.element.textContent).toBe("Tomás left."), { timeout: ANNOUNCE_QUIET + 1000 }); // latest wins
  },
};

/** Keystroke-style bursts never churn the region: one announcement leaves per quiet window. */
export const Burst: Story = {
  play: async () => {
    const a = handle!;
    const mounted = a.element;
    a.say("Suggestion is now stale.");
    for (let i = 0; i < 8; i++) a.say(`Intermediates drop ${i}.`);
    expect(a.element.textContent).toBe("Suggestion is now stale."); // the burst changed nothing mid-window
    expect(a.element).toBe(mounted); // the region itself never churns
    expect(mounted.isConnected).toBe(true);
    await waitFor(() => expect(a.element.textContent).toBe("Intermediates drop 7."), { timeout: ANNOUNCE_QUIET + 1000 });
    expect(a.element).toBe(mounted); // still the same node after the flush
    await quietPasses();
    a.say("Suggestion is now stale."); // an identical sentence still re-announces
    expect(a.element.textContent).toBe("Suggestion is now stale.");
  },
};
