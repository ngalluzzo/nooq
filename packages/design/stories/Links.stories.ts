import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";
import { resolveColor, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/**
 * Links (0009): the first payloaded mark, dogfooded through the same policy
 * contribution a plugin author would use. The reserved base `link` stores a
 * token over the covered characters and the href in the block's fields, so a
 * proposal's evidence sees an href edit. The writer-facing surface is
 * keyboard-first: select text, Mod-k, one field, Enter — Esc returns focus
 * and changes nothing (§9).
 */

const editors = new Set<Editor>();

function linkHost(): HTMLElement {
  const editor = new Editor({ docId: `links-story-${crypto.randomUUID()}`, actor: { actorId: "human:story", name: "Maya" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  page.append(surface.element);
  return page;
}

/** A native selection over character offsets, as a writer's drag would leave it. */
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

/** "#2343d1" → "rgb(35, 67, 209)", as getComputedStyle reports it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const meta = {
  title: "Components/Links",
  parameters: {
    docs: {
      description: {
        component:
          "Links in ink (brand book), through the payloaded-mark path every plugin shares (0009): a policy contributes the renderer, the rich host builds its mark schema from it, and the href rides the block's fields so evidence drift-detects href edits. The anchor carries the `nq-link` class — the theme owns every painted value. Mod-k opens the popover on a selection; Enter applies one atomic transaction, Esc returns focus with no change.",
      },
    },
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const EditorBacked: Story = {
  render: () => linkHost(),
  play: async ({ canvasElement, globals, userEvent }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const host = await waitFor(() => {
      const rich = canvasElement.querySelector<HTMLElement>(".nq-rich-text")!;
      expect(rich.textContent).toBe("Maya writes in ink.");
      return rich;
    });

    // Keyboard in: select "writes", Mod-k, type the href, Enter — one popover, one field.
    selectChars(host, 5, 11);
    await userEvent.keyboard("{Control>}k{/Control}");
    const input = await waitFor(() => within(document.body).getByLabelText("Link destination")) as HTMLInputElement;
    await expect(document.activeElement).toBe(input); // the field is the focus; the host keeps the selection
    await expect(input.value).toBe(""); // nothing linked yet
    await userEvent.type(input, "https://nooq.dev");
    await userEvent.keyboard("{Enter}");

    // The rendered anchor: the renderer's element, carrying the href, styled by class in ink.
    const anchor = await waitFor(() => {
      const rendered = host.querySelector<HTMLAnchorElement>("a.nq-link")!;
      expect(rendered).not.toBeNull();
      return rendered;
    });
    await expect(anchor.getAttribute("href")).toBe("https://nooq.dev");
    await expect(anchor.textContent).toBe("writes"); // the covered text is the anchor's content
    const style = getComputedStyle(anchor);
    await expect(style.color).toBe(rgb(resolveColor(tokens, "ink", theme)));
    await expect(style.textDecorationLine).toBe("underline"); // never color alone (§9)
    await expect(style.textDecorationColor).toBe(rgb(resolveColor(tokens, "ink", theme)));
    await expect(within(document.body).queryByLabelText("Link destination")).toBeNull(); // applied closes the popover
    await expect(host).toHaveFocus(); // and returns focus to the selection

    // Keyboard out: Esc dismisses the prefilled editor, unchanged, focus back on the host.
    selectChars(host, 5, 11);
    await userEvent.keyboard("{Control>}k{/Control}");
    const prefilled = await waitFor(() => within(document.body).getByLabelText("Link destination")) as HTMLInputElement;
    await expect(prefilled.value).toBe("https://nooq.dev"); // resolved from the selection's token and fields
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByLabelText("Link destination")).toBeNull();
    await expect(host).toHaveFocus();
    await expect(host.querySelector<HTMLAnchorElement>("a.nq-link")!.getAttribute("href")).toBe("https://nooq.dev"); // no change
  },
};
