import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";

/**
 * Superseded moves (DM-4.9) on a real editor surface: a concurrent peer's
 * move won the placement register, so the loser's surface names the winner
 * plainly and — only when the block still lives — offers the one fresh move
 * DM-4.9 allows ("Move it anyway"), causally now, which is also the
 * notice's dismissal. A delete that won gets DM-4.8's wording and only
 * Dismiss. The kind carries no fill escalation: this is history, not harm,
 * so the notice stays graphite on transparent with the history clock.
 *
 * THE RACE CANNOT BE TIMED HONESTLY HERE: a story's play steps are
 * sequential, and a second writer cannot be made concurrent with them. The
 * state is forced through the detector's seam (`surface.superseded.force`)
 * — the same emission path the honest feed reaches — while the losing move
 * itself is REAL (a genuine `moveBlock` in the history store, which is
 * exactly what the reassert action reads). The winner is named by actorId:
 * a local document has no awareness names to join, and the bare id is the
 * honest fallback.
 */

const editors = new Set<Editor>();
interface RaceFixture { surface: ReturnType<typeof createSurface>; editor: Editor; target: string; home: string }
const fixtures = new WeakMap<HTMLElement, RaceFixture>();

function raceHost(): HTMLElement {
  const editor = new Editor({ docId: `superseded-story-${crypto.randomUUID()}`, plugins: referencePlugins, jobBindings: referenceJobBindings(), actor: { actorId: "human:story", name: "You" } });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM });
  const target = editor.insertBlock({ type: paragraph.type, parent: null, text: "The paragraph you moved." });
  const home = editor.insertBlock({ type: paragraph.type, parent: null, text: "Where you meant to put it." });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  page.append(surface.element);
  fixtures.set(page, { surface, editor, target, home });
  return page;
}

function fixtureOf(canvasElement: HTMLElement): RaceFixture {
  const host = canvasElement.querySelector<HTMLElement>(".nq-doc");
  if (!host) throw new Error("superseded story host missing");
  const fixture = fixtures.get(host);
  if (!fixture) throw new Error("superseded story fixture missing");
  return fixture;
}

/** The losing move, as the detector's honest feed would hand it to the surface. */
function losingMove(editor: Editor, target: string) {
  const losing = [...editor.history()].reverse().find(tx => tx.ops.some(op => op.op === "move" && op.block === target));
  if (!losing) throw new Error("story fixture: no losing move on the target");
  return losing;
}

const meta = {
  title: "Components/Superseded moves",
  parameters: {
    docs: {
      description: {
        component:
          "A concurrent peer's move won the placement register for a block you moved (DM-4.9): the surface names the winner plainly — \"Maya moved this block at the same time you did. Their move won.\" — and offers reassertion, \"Move it anyway\", which runs ONE fresh move transaction to your original destination, causally after everything, so it wins through DM-4.7's ordinary resolution (never around it). The losing transaction stays in history with full provenance; a surface never retries, unwinds, or merges both intents. A move that raced a delete reads as deletion (DM-4.8's wording) with no reassert action. The notice is history, not an error: graphite on transparent, the history clock, no fill escalation.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const TheirMoveWon: Story = {
  render: () => raceHost(),
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement }) => {
    const { surface, editor, target, home } = fixtureOf(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block] textarea").length).toBe(2));

    // The real losing move — a genuine local move the reassert action will read.
    editor.moveBlock(target, home, 0);
    // The seam (see the story comment): the race cannot be timed in a story.
    surface.superseded.force({ block: target, losing: losingMove(editor, target), winningActor: "human:maya", deleted: false });

    const notice = canvasElement.querySelector<HTMLElement>(".nq-notice[data-kind='superseded']")!;
    await expect(notice).not.toBeNull();
    await expect(notice.getAttribute("role")).toBe("status");
    await expect(notice.querySelector(".nq-notice-word")?.textContent).toBe("human:maya moved this block at the same time you did. Their move won."); // the honest actorId fallback: no awareness names on a local document
    await expect(notice.querySelector("svg[data-glyph='history']")).toBeInTheDocument();

    // No fill escalation (the active theme's real values): history, not harm.
    const styles = getComputedStyle(notice);
    await expect(styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    await expect(styles.borderColor).toBe("rgba(0, 0, 0, 0)");

    // The action's presence: exactly "Move it anyway", and clicking it runs one fresh move.
    const button = notice.querySelector<HTMLButtonElement>("button")!;
    await expect(button.textContent).toBe("Move it anyway");
    const before = editor.history().length;
    button.click();
    const fresh = editor.history().slice(before);
    await expect(fresh).toHaveLength(1);
    await expect(fresh[0]!.intent).toBe("reassert-move");
    await expect(editor.view.blocks[home]!.children).toContain(target); // back at the loser's destination
    await expect(canvasElement.querySelector(".nq-notice")).toBeNull(); // the notice has said its piece
  },
};

export const DeletedWhileYouMovedIt: Story = {
  render: () => raceHost(),
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement }) => {
    const { surface, editor, target, home } = fixtureOf(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block] textarea").length).toBe(2));

    editor.moveBlock(target, home, 0); // the real losing move
    editor.deleteBlock(target); // the document matches the wording: the block is gone from the body
    surface.superseded.force({ block: target, losing: losingMove(editor, target), winningActor: "human:maya", deleted: true });

    const notice = canvasElement.querySelector<HTMLElement>(".nq-notice[data-kind='superseded']")!;
    await expect(notice).not.toBeNull();
    await expect(notice.querySelector(".nq-notice-word")?.textContent).toBe("human:maya deleted this block while you moved it."); // DM-4.8 wording (DM-4.9)

    // The action's absence: no reassertion into a tombstone — Dismiss is the only verb.
    const buttons = Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).map(button => button.textContent);
    await expect(buttons).toEqual(["Dismiss"]);

    // Dismissal clears the channel; the document is untouched by it.
    const before = editor.history().length;
    notice.querySelector<HTMLButtonElement>("button")!.click();
    await expect(canvasElement.querySelector(".nq-notice")).toBeNull();
    await expect(editor.history()).toHaveLength(before);
  },
};
