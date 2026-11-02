import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";
import { resolveColor, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/**
 * The formatting toolbar (foundation P1) on a real editor: rich mode, real
 * text, the pointer-selection policy end to end. A primary-button mouseup
 * completing a non-collapsed selection shows the strip with exactly the
 * bases the block's policy admits; a toggle rides the same mark path Mod-b
 * rides; Escape dismisses. The strip is pointer affordance only — never a
 * tab stop, never on the input path (§3) — and the suite runs under
 * prefers-reduced-motion, so nothing here relies on the 80ms fade.
 */

const editors = new Set<Editor>();

function richHost(): HTMLElement {
  const editor = new Editor({ docId: `format-story-${crypto.randomUUID()}`, actor: { actorId: "human:story", name: "Maya" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  page.append(surface.element);
  return page;
}

/** A native selection over character offsets, as a writer's drag would leave it (the unit harness's synthesis). */
function selectChars(host: HTMLElement, from: number, to: number): void {
  host.focus();
  const texts: Text[] = [];
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) texts.push(node as Text);
  const at = (offset: number): { node: Text; offset: number } => {
    let seen = 0;
    for (const node of texts) { if (offset <= seen + node.data.length) return { node, offset: offset - seen }; seen += node.data.length; }
    const last = texts.at(-1)!; return { node: last, offset: last.data.length };
  };
  const start = at(Math.min(from, to)), end = at(Math.max(from, to));
  const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
}

/** The policy event, synthesized as the unit test synthesizes it: a primary-button mouseup completing the selection. */
const pointerUp = (element: HTMLElement): void => {
  element.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, cancelable: true }));
};

const meta = {
  title: "Components/Formatting toolbar",
  parameters: {
    docs: {
      description: {
        component:
          "The selection-anchored strip of quiet toggles plus Link, pinned from a real rich host. POINTER selection only — a primary-button mouseup completing a non-collapsed selection; typing and keyboard-only selection never summon it (§3). The press never moves focus, the buttons are never tab stops (the chords are the keyboard path), Escape dismisses, and placement never covers the caret's line. Every painted value is a token: the strip floats on paper-raised with shadow-pop, and a pressed toggle takes the accepted-state treatment, ink-soft with ink.",
      },
    },
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const PointerSelection: Story = {
  render: () => richHost(),
  play: async ({ canvasElement, globals, userEvent }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const host = await waitFor(() => {
      const rich = canvasElement.querySelector<HTMLElement>(".nq-rich-text")!;
      expect(rich.textContent).toBe("Maya writes in ink.");
      return rich;
    });
    const strip = canvasElement.querySelector<HTMLElement>(".nq-format")!;
    expect(strip.hidden).toBe(true); // resting state: nothing is shown

    // The policy event: select "writes", release the primary button.
    selectChars(host, 5, 11);
    pointerUp(host);
    await expect(strip.hidden).toBe(false);
    expect(strip.getAttribute("role")).toBe("toolbar");
    const labels = Array.from(strip.querySelectorAll("button")).map(el => el.textContent);
    expect(labels).toEqual(["Bold", "Italic", "Code", "Link"]); // exactly what the reference policy admits
    for (const button of Array.from(strip.querySelectorAll("button"))) expect(button.getAttribute("aria-pressed")).toBe("false");
    // The strip is pointer affordance only: its buttons are never tab stops (§3), and focus stays in the text.
    for (const button of Array.from(strip.querySelectorAll("button"))) expect(button.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(host);

    // Every painted value is a token, in both themes: the strip floats on paper-raised.
    expect(rgb(getComputedStyle(strip).backgroundColor)).toBe(rgb(resolveColor(tokens, "paper-raised", theme)));

    // Toggle Bold through the strip: the press is prevented (the selection
    // survives), the mark rides the real path, and strong renders.
    const bold = strip.querySelector<HTMLButtonElement>("[data-nq-base='strong']")!;
    const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    bold.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    pointerUp(bold); bold.click();
    const strong = await waitFor(() => {
      const rendered = host.querySelector<HTMLElement>("strong")!;
      expect(rendered.textContent).toBe("writes");
      return rendered;
    });
    expect(bold.getAttribute("aria-pressed")).toBe("true"); // the pressed state tells what the next click does
    expect(rgb(getComputedStyle(bold).backgroundColor)).toBe(rgb(resolveColor(tokens, "ink-soft", theme))); // the accepted-state treatment
    expect(rgb(getComputedStyle(bold).color)).toBe(rgb(resolveColor(tokens, "ink", theme)));
    expect(document.activeElement).toBe(host); // focus never left the text

    // Escape dismisses (the surface consumes it; the strip obeys).
    await userEvent.keyboard("{Escape}");
    await expect(strip.hidden).toBe(true);
  },
};

/** "#2343d1" → "rgb(35, 67, 209)", as getComputedStyle reports it. */
function rgb(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color.trim(); // already a computed form (rgb()/color-mix()); compare as-is
  const n = parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
