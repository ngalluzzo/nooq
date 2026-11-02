import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";

/**
 * Away markers (foundation P1) on a real editor: a remote change to a block
 * the writer could not see — windowed out — marks its row. The bar keeps the
 * writer's ink and renders notched (one gap mid-bar; dashed is the AI hand
 * and dotted the machine's, so away is a shape), the row's sr word says it,
 * and focusing the block clears both.
 *
 * Windowing cannot be simulated honestly in this harness — everything mounts
 * — so the mark is forced through the tracker's seam (`surface.away.force`),
 * the same set a remote ChangeEvent naming an unmounted block lands in. The
 * clears run through the surface's real triggers: focus below is a real
 * focusin into the row. Computed styles are asserted here, in real Chromium,
 * once per theme (the suite runs light and dark; axe runs with them).
 * Nothing animates, so prefers-reduced-motion changes nothing (§3).
 */

const editors = new Set<Editor>();
interface AwayFixture { surface: ReturnType<typeof createSurface>; plain: string; marked: string }
const fixtures = new WeakMap<HTMLElement, AwayFixture>();

function editorHost(): HTMLElement {
  const editor = new Editor({ docId: `away-story-${crypto.randomUUID()}`, plugins: referencePlugins, jobBindings: referenceJobBindings(), actor: { actorId: "human:story", name: "Maya" } });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM });
  const plain = editor.insertBlock({ type: paragraph.type, parent: null, text: "The paragraph you were watching." });
  const marked = editor.insertBlock({ type: paragraph.type, parent: null, text: "The paragraph that changed while you were away." });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  page.append(surface.element);
  fixtures.set(page, { surface, plain, marked });
  return page;
}

function fixtureOf(canvasElement: HTMLElement): AwayFixture {
  const host = canvasElement.querySelector<HTMLElement>(".nq-doc");
  if (!host) throw new Error("away story host missing");
  const fixture = fixtures.get(host);
  if (!fixture) throw new Error("away story fixture missing");
  return fixture;
}

const meta = {
  title: "Components/Away markers",
  parameters: {
    docs: {
      description: {
        component:
          "A remote change to a block outside your window marks its row: the surface sets `data-nq-away` on the row shell and injects an `.nq-sr` word (\"Changed while you were away\") — the visual bar stays the view's own, keeping the writer's ink but rendered notched, one gap mid-bar, because dashed is AI and dotted is machine. Exactly three things clear it: focus into the row, a local edit, or opening the block's history. Mounting, scrolling and time never do; marks are session-local. Give blocks away markers by mounting them on the nooq surface (`createSurface` wires the tracker); third-party views need nothing — the attribute rides the shell the surface owns.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const NotchedBar: Story = {
  render: () => editorHost(),
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement }) => {
    const { surface, plain, marked } = fixtureOf(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block] textarea").length).toBe(2));

    // The seam (see the story comment): force the mark the honest path needs
    // a windowed-out block for.
    surface.away.force(marked);
    const markedRow = canvasElement.querySelector<HTMLElement>(`[data-nq-block="${marked}"]`)!;
    const plainRow = canvasElement.querySelector<HTMLElement>(`[data-nq-block="${plain}"]`)!;
    await expect(markedRow.hasAttribute("data-nq-away")).toBe(true);
    await expect(plainRow.hasAttribute("data-nq-away")).toBe(false); // only the marked row, never its neighbours
    await expect(markedRow.querySelector(".nq-sr")?.textContent).toBe("Changed while you were away"); // the word channel (§9)

    // The visual channel, computed in the active theme: the notch replaces the solid ground.
    const awayBar = getComputedStyle(markedRow.querySelector<HTMLElement>(".nq-bar")!);
    const plainBar = getComputedStyle(plainRow.querySelector<HTMLElement>(".nq-bar")!);
    await expect(plainBar.backgroundImage).toBe("none");
    await expect(awayBar.backgroundImage).toContain("repeating-linear-gradient");
    await expect(awayBar.backgroundImage).not.toBe(plainBar.backgroundImage);
    // The writer's ink is unchanged: the notch paints in the same resolved color as the plain bar's ground.
    const paints = awayBar.backgroundImage.match(/rgb\([^)]+\)/g) ?? [];
    await expect(paints.length).toBeGreaterThan(0);
    await expect(paints[0]).toBe(plainBar.backgroundColor);

    // Focus is the writer's visit: entering the marked row clears the notch and the word.
    markedRow.querySelector<HTMLElement>("textarea")!.focus();
    await expect(surface.away.isMarked(marked)).toBe(false);
    await expect(markedRow.hasAttribute("data-nq-away")).toBe(false);
    await expect(markedRow.querySelector(".nq-sr")).toBeNull();
    await expect(getComputedStyle(markedRow.querySelector<HTMLElement>(".nq-bar")!).backgroundImage).toBe(plainBar.backgroundImage); // back to the solid ground
  },
};
