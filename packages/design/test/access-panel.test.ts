/** Access panel: who can edit, in which role — self first, verified as the weak verdict, idle as a word (§9). */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { accessPanel, type AccessPanelEntry } from "../src/index.ts";

const ENTRIES: readonly AccessPanelEntry[] = [
  { actorId: "human:ren", name: "Ren", role: "writer", owner: true, ink: "magenta" },
  { actorId: "human:tomas", name: "Tomás", role: "writer", ink: "teal", verified: true },
  { actorId: "human:kai", name: "Kai", role: "writer", ink: "sepia", idle: true },
  { actorId: "human:3d91f2ab", role: "reader", ink: "green" },
  { actorId: "ai:reference", kind: "ai", model: "simulated/1", role: "suggester" },
];

function panel(): HTMLDivElement {
  return accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: ENTRIES });
}

describe("accessPanel", () => {
  test("self renders first: chip, role word, and the word you in ui-caption", () => {
    const root = panel();
    const self = root.querySelector<HTMLElement>(".nq-access-self")!;
    expect(root.querySelector(".nq-access-row")).toBe(self); // the first row is the self row
    expect(self.getAttribute("data-nq-actor")).toBe("human:maya");
    expect(self.querySelector(".nq-actor-name")?.textContent).toBe("Maya");
    expect(self.querySelector(".nq-access-role")?.textContent).toBe("Writer");
    const you = self.querySelector<HTMLElement>(".nq-access-you")!;
    expect(you.textContent).toBe("you");
    expect(you.classList.contains("nq-ui-caption")).toBe(true);
  });

  test("entries render in order — owner, then grants as given — one row per party", () => {
    const root = panel();
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".nq-access-row"));
    expect(rows.map(row => row.getAttribute("data-nq-actor"))).toEqual([
      "human:maya", "human:ren", "human:tomas", "human:kai", "human:3d91f2ab", "ai:reference",
    ]);
    const owner = rows[1]!;
    expect(owner.hasAttribute("data-owner")).toBe(true);
    expect(owner.querySelector(".nq-access-role")?.textContent).toBe("Owner"); // the owner's own noun, not a grant role
  });

  test("role words are sentence case, in ui-caption, for every role", () => {
    const root = panel();
    const roles = Array.from(root.querySelectorAll<HTMLElement>(".nq-access-role"));
    expect(roles.map(el => el.textContent)).toEqual(["Writer", "Owner", "Writer", "Writer", "Reader", "Suggester"]);
    for (const el of roles) expect(el.classList.contains("nq-ui-caption")).toBe(true);
    const checkpointer = accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: [{ actorId: "human:cp", role: "checkpointer" }] });
    expect(checkpointer.querySelector('.nq-access-row[data-nq-actor="human:cp"] .nq-access-role')?.textContent).toBe("Checkpointer");
  });

  test("a grant without a joined name renders the bare actor id — no invented names", () => {
    const root = panel();
    const bare = root.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:3d91f2ab"]')!;
    expect(bare.querySelector(".nq-actor-name")?.textContent).toBe("human:3d91f2ab");
    expect(bare.querySelector(".nq-access-role")?.textContent).toBe("Reader");
  });

  test("verified renders the glyph with its exact title, and never renders without the flag", () => {
    const root = panel();
    const verified = root.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:tomas"] .nq-access-verified')!;
    expect(verified.getAttribute("title")).toBe("Their edits arrived verified here");
    expect(verified.querySelector("[data-glyph='verified']")).not.toBeNull();
    expect(root.querySelector('.nq-access-row[data-nq-actor="human:ren"] .nq-access-verified')).toBeNull();
  });

  test("idle carries its word in ui-caption, and only on the idle row", () => {
    const root = panel();
    const idle = root.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:kai"]')!;
    expect(idle.hasAttribute("data-idle")).toBe(true);
    expect(idle.querySelector(".nq-access-idle")?.textContent).toBe("idle");
    expect(idle.querySelector(".nq-access-idle")?.classList.contains("nq-ui-caption")).toBe(true);
    expect(root.querySelector('.nq-access-row[data-nq-actor="human:tomas"] .nq-access-idle')).toBeNull();
  });

  test("an AI grant renders the chip's kind and model (§5)", () => {
    const root = panel();
    const ai = root.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="ai:reference"]')!;
    expect(ai.querySelector(".nq-actor")?.classList.contains("nq-actor-ai")).toBe(true);
    expect(ai.querySelector(".nq-actor-model")?.textContent).toBe("simulated/1");
    expect(ai.querySelector(".nq-actor-kind")?.textContent).toBe("AI");
  });

  test("the footnote states the revocation timing plainly, in ui-caption (DM-13.6)", () => {
    const root = panel();
    const note = root.querySelector<HTMLElement>(".nq-access-note")!;
    expect(note.classList.contains("nq-ui-caption")).toBe(true);
    expect(note.textContent).toBe("Removing a writer takes effect per device at sync time (DM-13.6).");
  });

  test("inline styles are token references only: a peer chip carries its derived ink, the self chip the local ink", () => {
    const root = panel();
    const peer = root.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:tomas"] .nq-actor')!;
    expect(peer.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-teal)");
    const self = root.querySelector<HTMLElement>(".nq-access-self .nq-actor")!;
    expect(self.style.getPropertyValue("--nq-peer")).toBe("var(--nq-ink)"); // the local writer renders in ink
    // The only inline styles anywhere are these --nq-peer token references; every painted value stays a token.
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      for (const prop of Array.from(el.style)) if (prop !== "--nq-peer") throw new Error(`inline style ${prop} on ${el.className}`);
    }
  });
});
