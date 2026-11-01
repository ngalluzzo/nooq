/** Presence roster: who is here, in which ink — self first, idle as a word (§9). */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { presenceRoster, type PresenceRosterPeer } from "../src/index.ts";

const PEERS: readonly PresenceRosterPeer[] = [
  { actor: "human:tomas", name: "Tomás", ink: "teal" },
  { actor: "human:ana", name: "Ana", ink: "violet" },
  { actor: "human:kai", name: "Kai", ink: "sepia", idle: true },
];

describe("presenceRoster", () => {
  test("self renders first, with its dot in ink", () => {
    const roster = presenceRoster({ self: "Maya", peers: PEERS });
    const first = roster.querySelector<HTMLElement>(".nq-roster-self")!;
    expect(roster.firstElementChild).toBe(first);
    expect(first.querySelector(".nq-roster-name")?.textContent).toBe("Maya");
    expect(first.querySelector(".nq-roster-dot")).not.toBeNull();
  });

  test("each peer renders a dot and their name, in order, in ui-label", () => {
    const roster = presenceRoster({ self: "Maya", peers: PEERS });
    const peers = Array.from(roster.querySelectorAll<HTMLElement>(".nq-roster-peer"));
    expect(peers.map(peer => peer.querySelector(".nq-roster-name")?.textContent)).toEqual(["Tomás", "Ana", "Kai"]);
    for (const peer of peers) {
      expect(peer.querySelector(".nq-roster-name")?.classList.contains("nq-ui-label")).toBe(true);
      expect(peer.querySelector(".nq-roster-dot")).not.toBeNull();
    }
  });

  test("a peer's dot carries their derived ink as a token reference, never a color", () => {
    const roster = presenceRoster({ self: "Maya", peers: [PEERS[0]!] });
    const peer = roster.querySelector<HTMLElement>(".nq-roster-peer")!;
    expect(peer.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-teal)");
  });

  test("the roster is a wrap: dots are decorative, names carry the content", () => {
    const roster = presenceRoster({ self: "Maya", peers: PEERS });
    expect(roster.classList.contains("nq-roster")).toBe(true);
    for (const dot of Array.from(roster.querySelectorAll(".nq-roster-dot"))) expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(roster.textContent).toContain("Tomás");
  });

  test("an idle peer carries the word idle in ui-caption, and the word never renders for an active one", () => {
    const roster = presenceRoster({ self: "Maya", peers: PEERS });
    const idle = roster.querySelector<HTMLElement>(".nq-roster-peer[data-idle]")!;
    const word = idle.querySelector<HTMLElement>(".nq-roster-idle")!;
    expect(word.textContent).toBe("idle");
    expect(word.classList.contains("nq-ui-caption")).toBe(true);
    const active = roster.querySelectorAll<HTMLElement>(".nq-roster-peer")[0]!;
    expect(active.hasAttribute("data-idle")).toBe(false);
    expect(active.querySelector(".nq-roster-idle")).toBeNull();
  });

  test("alone is a self chip and nothing else", () => {
    const roster = presenceRoster({ self: "Maya", peers: [] });
    expect(roster.querySelector(".nq-roster-self")).not.toBeNull();
    expect(roster.querySelector(".nq-roster-peer")).toBeNull();
  });
});
