import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { column, columns, essentials, paragraph } from "../../plugins/src/essentials.ts";
import { callout, callouts } from "../../plugin-callouts/src/index.ts";
import { calloutsDOM } from "../../plugin-callouts/src/dom.ts";
import type { Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/**
 * Multi-column layout (foundation P2): `nooq.columns/v1` carrying two
 * `nooq.column/v1` children, each seeded with content — a paragraph and a
 * callout, so the surface renders plugin blocks inside the grid. Reading
 * order is the rule: tree order = column order = DOM order, and narrow
 * widths stack in that same order (a max-width media query, documented in
 * nooq.css). The consumer provides only the two block types and the insert
 * command from essentials; the theme does the layout — do not restyle the
 * grid, override the tokens (`column-gap`, `block-gap`) instead. Nothing
 * animates, so reduced motion changes nothing here.
 */

const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; ids: Record<"columnsId" | "left" | "leftText" | "right" | "rightText", string> }>();

/** The token's declared value ("24px"), so assertions follow the source of truth. */
function editorToken(name: string): string {
  const token = tokens.editor.tokens.find(t => t.name === name);
  if (!token) throw new Error(`unknown editor token ${name}`);
  return token.value;
}

function twoColumns(): HTMLElement {
  const editor = new Editor({ docId: `two-columns-${crypto.randomUUID()}`, actor: { actorId: "human:story", name: "Maya" }, plugins: [essentials, callouts] });
  editors.add(editor);
  editor.insertBlock({ type: paragraph.type, parent: null, text: "The pilot review, side by side." });
  const columnsId = editor.insertBlock({ type: columns.type, parent: null });
  const left = editor.insertBlock({ type: column.type, parent: columnsId });
  const leftText = editor.insertBlock({ type: paragraph.type, parent: left, text: "What the pilot taught us: offline first, then sync." });
  editor.insertBlock({ type: callout.type, parent: left, text: "Three of four teams kept using it.", fields: { tone: "info" } });
  const right = editor.insertBlock({ type: column.type, parent: columnsId });
  const rightText = editor.insertBlock({ type: paragraph.type, parent: right, text: "What it cost: one afternoon a week." });
  editor.insertBlock({ type: callout.type, parent: right, text: "For six weeks, never more.", fields: { tone: "warning" } });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "After the columns, the document flows on." });
  const surface = createSurface(editor, { plugins: [essentialsDOM, calloutsDOM], textMode: "rich" });
  const page = document.createElement("div");
  page.className = "nq-doc"; // the reference framing: measure + gutter, no story sizing
  page.dataset.twoColumnsDemo = "true";
  page.append(surface.element);
  fixtures.set(page, { editor, ids: { columnsId, left, leftText, right, rightText } });
  return page;
}

const meta = {
  title: "Components/Two columns",
  parameters: {
    docs: {
      description: {
        component:
          "Two parallel columns as ordinary blocks: the columns view is a plain element whose own children container the theme turns into a two-track grid (`repeat(2, minmax(0, 1fr))`, `column-gap` between, `block-gap` rows); the nesting treatment resets inside it — no gutter indent, no rule border — because columns are parallel, not depth, while a column's own children keep the plain stacking. Reading order is the rule (foundation.md): tree order = column order = DOM order, and narrow widths stack in that same order. Provide the block types and the `insert-columns` command from essentials — the slash menu offers it as “Two columns” — and theme by overriding tokens, never the grid.",
      },
    },
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const SideBySide: Story = {
  render: () => twoColumns(),
  play: async ({ canvasElement, userEvent }) => {
    const page = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>("[data-two-columns-demo]")!;
      expect(found.querySelector(".nq-columns")).not.toBeNull();
      return found;
    });
    const { editor, ids } = fixtures.get(page)!;
    const columnsRow = page.querySelector<HTMLElement>(`[data-nq-block="${ids.columnsId}"]`)!;

    // The views: plain elements carrying the classes, children retained.
    expect(columnsRow.querySelector(":scope > .nq-columns")).not.toBeNull();
    const grid = columnsRow.querySelector<HTMLElement>(":scope > .nq-columns > .nq-children")!;

    // The grid: two equal tracks, the column-gap gutter, block-gap rows.
    const style = getComputedStyle(grid);
    await expect(style.display).toBe("grid");
    await expect(style.gridTemplateColumns.trim().split(/\s+/)).toHaveLength(2);
    await expect(style.columnGap).toBe(editorToken("column-gap"));
    await expect(style.rowGap).toBe(editorToken("block-gap"));
    // The nesting treatment resets inside columns: no gutter indent, no rule border.
    await expect(style.paddingInlineStart).toBe("0px");
    await expect(style.borderInlineStartWidth).toBe("0px");

    // Tree order = DOM order: the column shells sit in the grid, left then right.
    const order = Array.from(grid.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.nqBlock !== undefined)
      .map(child => child.dataset.nqBlock);
    await expect(order).toEqual([ids.left, ids.right]);
    // Column 1's content precedes column 2's in the DOM — reading order, verifiable by text position.
    const text = grid.textContent!;
    await expect(text).toContain("What the pilot taught us");
    await expect(text).toContain("What it cost");
    await expect(text.indexOf("What the pilot taught us")).toBeLessThan(text.indexOf("What it cost"));
    // Plugin blocks render inside the grid: one callout per column.
    const calloutsInColumns = Array.from(grid.querySelectorAll<HTMLElement>(".nq-block-container"));
    await expect(calloutsInColumns).toHaveLength(2);
    for (const columnId of [ids.left, ids.right]) {
      const shell = grid.querySelector<HTMLElement>(`[data-nq-block="${columnId}"]`)!;
      expect(shell.querySelector(":scope > .nq-column")).not.toBeNull();
      // A column's own children container stays plain flex stacking with the nesting treatment.
      const children = shell.querySelector<HTMLElement>(":scope > .nq-column > .nq-children")!;
      expect(getComputedStyle(children).display).toBe("flex");
      expect(children.contains(calloutsInColumns.find(calloutEl => shell.contains(calloutEl))!)).toBe(true);
    }

    // The keyboard path: the caret lands in column 1's paragraph and types there.
    const host = grid.querySelector<HTMLElement>(`[data-nq-block="${ids.leftText}"] .nq-rich-text`)!;
    await userEvent.click(host);
    await userEvent.keyboard("!");
    await waitFor(() => expect(editor.view.blocks[ids.leftText]!.text!.s.endsWith("!")).toBe(true));
  },
};
