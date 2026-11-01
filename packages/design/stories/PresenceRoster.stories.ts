import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { presenceRoster, type PresenceRosterProps } from "../src/index.ts";
import { row } from "./fixtures.ts";

const meta = {
  title: "Components/PresenceRoster",
  render: (args) => presenceRoster(args),
  args: {
    self: "Maya",
    peers: [
      { actor: "human:tomas", name: "Tomás", ink: "teal" },
      { actor: "human:ana", name: "Ana", ink: "violet" },
    ],
  },
  parameters: {
    docs: {
      description: {
        component:
          "Who is here, in which ink, beside the sync line: the self chip leads with its dot in ink, then one chip per peer with their derived ink dot (radius-full, the system's only full-radius shape) and name. An idle peer's name dims AND carries the word \"idle\" — state as a word, never dimming alone (§9). The consumer owns membership and idle judgement; hosts cap the row or let it wrap. Not for the overlay: PresenceCaret owns carets and flags inside text.",
      },
    },
  },
} satisfies Meta<PresenceRosterProps>;

export default meta;
type Story = StoryObj<PresenceRosterProps>;

export const TwoPeers: Story = {
  play: async ({ canvas }) => {
    const roster = canvas.getByText("Tomás").closest(".nq-roster")!;
    // Self leads; peers follow in order, each with their derived ink as a token.
    expect(roster.querySelector(".nq-roster-self .nq-roster-name")?.textContent).toBe("Maya");
    const peers = Array.from(roster.querySelectorAll<HTMLElement>(".nq-roster-peer"));
    expect(peers.map(peer => peer.querySelector(".nq-roster-name")?.textContent)).toEqual(["Tomás", "Ana"]);
    expect(peers[0]!.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-teal)");
    expect(peers[1]!.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-violet)");
  },
};

export const Alone: Story = {
  args: { self: "Maya", peers: [] },
  play: async ({ canvas }) => {
    const roster = canvas.getByText("Maya").closest(".nq-roster")!;
    expect(roster.querySelector(".nq-roster-self")).not.toBeNull();
    expect(roster.querySelector(".nq-roster-peer")).toBeNull();
  },
};

/** Idle is the caller's judgement; the roster only guarantees it is never dimming alone. */
export const WithIdle: Story = {
  args: {
    self: "Maya",
    peers: [
      { actor: "human:tomas", name: "Tomás", ink: "teal", idle: true },
      { actor: "human:ana", name: "Ana", ink: "violet" },
    ],
  },
  play: async ({ canvasElement }) => {
    const roster = canvasElement.querySelector<HTMLElement>(".nq-roster")!;
    const [idle, active] = Array.from(roster.querySelectorAll<HTMLElement>(".nq-roster-peer"));
    // The word carries the state (§9) — and the name dims with it, never instead of it.
    expect(idle!.querySelector(".nq-roster-idle")?.textContent).toBe("idle");
    expect(active!.querySelector(".nq-roster-idle")).toBeNull();
    const idleName = idle!.querySelector<HTMLElement>(".nq-roster-name")!;
    const activeName = active!.querySelector<HTMLElement>(".nq-roster-name")!;
    expect(getComputedStyle(idleName).color).not.toBe(getComputedStyle(activeName).color);
  },
};

/** A full table: six peers across the six inks (two share one — the names tell them apart). */
export const FullHouse: Story = {
  render: () =>
    row(
      presenceRoster({
        self: "Maya",
        peers: [
          { actor: "human:tomas", name: "Tomás", ink: "teal" },
          { actor: "human:ana", name: "Ana", ink: "violet" },
          { actor: "human:juno", name: "Juno", ink: "green" },
          { actor: "human:kai", name: "Kai", ink: "sepia" },
          { actor: "human:pru", name: "Pru", ink: "magenta" },
          { actor: "human:leo", name: "Leo", ink: "slate", idle: true },
        ],
      }),
    ),
  play: async ({ canvasElement }) => {
    const roster = canvasElement.querySelector<HTMLElement>(".nq-roster")!;
    expect(roster.querySelectorAll(".nq-roster-peer")).toHaveLength(6);
    // Presence dots are the only radius-full shapes in the system.
    for (const dot of Array.from(roster.querySelectorAll<HTMLElement>(".nq-roster-dot"))) {
      expect(getComputedStyle(dot).borderRadius).not.toBe("0px");
    }
  },
};
