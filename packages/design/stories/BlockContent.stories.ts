import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { blockRow, resolveColor, type Tokens } from "../src/index.ts";
import { el } from "../src/dom.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/** A length token's declared value ("44px"), so assertions follow the source of truth. */
function lengthToken(family: "spacing" | "radius" | "size" | "highlight" | "motion" | "layer" | "editor", name: string): string {
  const token = tokens[family].tokens.find((t) => t.name === name);
  if (!token) throw new Error(`unknown token ${family}.${name}`);
  return token.value;
}
const px = (value: string): number => parseFloat(value);

function doc(...rows: Node[]): HTMLDivElement {
  return el("div", { class: "nq-doc" }, ...rows);
}
function host(text: string): HTMLTextAreaElement {
  const area = el("textarea", { class: "nq-input nq-doc-body", "aria-label": "Text" });
  area.value = text;
  return area;
}
function children(...rows: Node[]): HTMLDivElement {
  return el("div", { class: "nq-children" }, ...rows);
}
function paragraph(text: string, ...extra: Node[]): ReturnType<typeof blockRow> {
  return blockRow({ content: [host(text), ...extra], writer: "Maya" });
}

const meta = {
  title: "Components/Block content",
  parameters: {
    docs: {
      description: {
        component:
          "Content styles around the text hosts: children indent to the gutter with a rule per nesting level, an empty block carries the hint “Type / for blocks” (the textarea's placeholder attribute for plain hosts, `data-nq-empty` plus `::before` for rich ones), and windowed runs render as quiet skeletons that hold estimated height without shimmer (§3). List, code-block and divider classes are ready for when those blocks exist — the consumer builds the block's DOM with them; a host never writes its own sizes, only token overrides.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** "#2343d1" → "rgb(35, 67, 209)", as getComputedStyle reports it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

export const Nesting: Story = {
  render: () =>
    doc(
      paragraph(
        "We shipped the offline mode to four teams in July.",
        children(
          paragraph("None of them noticed when the sync server went down for a day.", children(paragraph("The incident review praised the offline queue."))),
          // A block with no children yet: its container draws nothing.
          paragraph("Pricing comes later.", children()),
        ),
      ),
    ),
  play: async ({ canvas, canvasElement, globals }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const groups = storyRoot(canvasElement).querySelectorAll<HTMLElement>(".nq-children");
    await expect(groups).toHaveLength(3);
    const indent = `${px(lengthToken("editor", "gutter")) - px(lengthToken("editor", "change-bar"))}px`;
    for (const group of Array.from(groups)) {
      await expect(getComputedStyle(group).paddingInlineStart).toBe(indent);
      await expect(getComputedStyle(group).borderInlineStartWidth).toBe(lengthToken("editor", "change-bar"));
      await expect(getComputedStyle(group).borderInlineStartColor).toBe(rgb(resolveColor(tokens, "rule", theme)));
    }
    // Sibling children sit a block gap apart, like blocks outside them.
    await expect(getComputedStyle(groups[0]!).rowGap).toBe(lengthToken("editor", "block-gap"));
    // Empty children containers are not drawn: no stray rule, no stray gap.
    await expect(getComputedStyle(groups[2]!).display).toBe("none");
  },
};

export const EmptyBlocks: Story = {
  render: () =>
    el(
      "div",
      { class: "sb-stack", style: { maxWidth: "var(--nq-measure)" } },
      el("textarea", { class: "nq-input nq-doc-body", "aria-label": "Empty plain block", placeholder: "Type / for blocks" }),
      el("div", {
        class: "nq-input nq-rich-text nq-doc-body", role: "textbox", "aria-multiline": "true", "aria-label": "Empty rich block",
        contenteditable: "true", "data-nq-empty": "", style: { "white-space": "pre-wrap", "overflow-wrap": "anywhere", "min-height": "2em" },
      }),
    ),
  play: async ({ canvas, canvasElement, globals }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const plain = canvas.getByRole("textbox", { name: "Empty plain block" }) as HTMLTextAreaElement;
    await expect(plain.placeholder).toBe("Type / for blocks");
    const rich = canvas.getByRole("textbox", { name: "Empty rich block" });
    const hint = getComputedStyle(rich, "::before");
    await expect(hint.content).toBe('"Type / for blocks"');
    await expect(hint.color).toBe(rgb(resolveColor(tokens, "graphite-muted", theme)));
  },
};

export const WindowedRun: Story = {
  render: () =>
    // The surface root scopes the windowing styles, as in the real editor.
    el("div", { class: "nq-editor" }, doc(
      paragraph("The mounted run keeps its place; the estimated run below holds its height."),
      el("div", { "data-nq-ph": "1", style: { height: "calc(var(--nq-space-12) * 2)" } }),
      paragraph("…and the document continues below the window."),
    )),
  play: async ({ canvas, canvasElement, globals }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const run = storyRoot(canvasElement).querySelector<HTMLElement>("[data-nq-ph]")!;
    const style = getComputedStyle(run);
    // Quiet: a flat sunken ground that holds height. No shimmer, no animation (§3).
    await expect(style.backgroundColor).toBe(rgb(resolveColor(tokens, "paper-sunken", theme)));
    await expect(style.animationName).toBe("none");
    await expect(style.height).toBe(`${px(lengthToken("spacing", "space-12")) * 2}px`);
  },
};

export const BlockTypes: Story = {
  render: () =>
    doc(
      blockRow({ content: el("ul", { class: "nq-block-list" },
        el("li", { class: "nq-doc-body" }, "Field notes, July"),
        el("li", { class: "nq-doc-body" }, "Offline by default"),
        el("li", { class: "nq-doc-body" }, "One license, every feature"),
      ), writer: "Maya" }),
      blockRow({ content: el("pre", { class: "nq-block-code nq-code" }, "nooq.paragraph/v1\nnooq.heading/v1\nnooq.quote/v1"), writer: "Maya" }),
      el("hr", { class: "nq-block-divider" }),
      paragraph("Type ids set in the data face, compared by a machine, kept by a person."),
    ),
  play: async ({ canvas, canvasElement, globals }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const root = storyRoot(canvasElement);
    const list = root.querySelector<HTMLElement>(".nq-block-list")!;
    await expect(getComputedStyle(list).paddingInlineStart).toBe(lengthToken("editor", "gutter"));
    await expect(getComputedStyle(root.querySelector("li")!).color).toBe(rgb(resolveColor(tokens, "graphite", theme)));
    const code = root.querySelector<HTMLElement>(".nq-block-code")!;
    const codeStyle = getComputedStyle(code);
    await expect(codeStyle.backgroundColor).toBe(rgb(resolveColor(tokens, "paper-sunken", theme)));
    await expect(codeStyle.whiteSpace).toBe("pre-wrap");
    await expect(code.classList.contains("nq-code")).toBe(true);
    const divider = root.querySelector<HTMLElement>(".nq-block-divider")!;
    const dividerStyle = getComputedStyle(divider);
    await expect(dividerStyle.borderTopColor).toBe(rgb(resolveColor(tokens, "rule", theme)));
    await expect(dividerStyle.marginTop).toBe(lengthToken("spacing", "space-2"));
    await expect(dividerStyle.marginBottom).toBe(lengthToken("spacing", "space-2"));
  },
};

function storyRoot(root: HTMLElement): HTMLElement {
  const container = root.querySelector<HTMLElement>(".nq-doc")?.parentElement ?? root;
  return container;
}
