import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor } from "../../editor/src/index.ts";
import { createSurface } from "../../editor/src/dom.ts";
import { referenceDOM, referencePlugins, referenceJobBindings } from "../../editor/src/reference.ts";
import { essentials } from "../../plugins/src/essentials.ts";
import { insertTable, addRowAfter, toggleHeaderRow } from "../../plugin-tables/src/index.ts";
import { codePlugin } from "../../plugin-code/src/index.ts";
import { codeDOM } from "../../plugin-code/src/dom.ts";
import { mathPlugin } from "../../plugin-math/src/index.ts";
import { mathDOM } from "../../plugin-math/src/dom.ts";

/**
 * Tables, interactive (0015's showcase): a real surface — the growth buttons
 * add rows and columns in one transaction each; the ragged row draws its
 * ghost and one click repairs it; Tab crosses cells; the drag handle moves
 * rows. Everything here is the product's own machinery.
 */

const meta = {
  title: "Surface/Tables",
  parameters: {
    docs: {
      description: {
        component:
          "The table surface live: growth (both directions, one transaction each), the honestly ragged row with its one-click repair, headers, cell typing, Tab navigation.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

function build(): { element: HTMLElement; editor: Editor } {
  const editor = new Editor({ docId: "tables-demo", actor: { actorId: "human:you", name: "You" }, jobBindings: referenceJobBindings(), plugins: [...referencePlugins, codePlugin, mathPlugin] });
  editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "Above" });
  editor.commands.run(insertTable, { parent: null, index: 1 });
  const tableId = editor.view.roots[1]!;
  const rows = editor.view.blocks[tableId]!.children as string[];
  const cells = (row: string): string[] => editor.view.blocks[row]!.children as string[];
  cells(rows[0]!).forEach((cell, i) => editor.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: `Column ${i + 1}` }] }));
  cells(rows[1]!).forEach((cell, i) => editor.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: ["alpha", "beta", "gamma"][i] ?? "" }] }));
  editor.commands.run(toggleHeaderRow, { row: rows[0]! });
  editor.commands.run(addRowAfter, { afterRow: rows[1]! });
  const third = (editor.view.blocks[tableId]!.children as string[])[2]!;
  editor.commands.run("nooq.text.edit", { block: cells(third)[0]!, changes: [{ insert: "short" }] });
  editor.commands.run("nooq.block.delete", { block: cells(third)[1]! }); // ragged on purpose
  editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "Below" });
  const surface = createSurface(editor, { plugins: [...referenceDOM, codeDOM, mathDOM] });
  const page = document.createElement("div");
  page.style.cssText = "display:flex;flex-direction:column;gap:var(--nq-space-6);max-width:calc(var(--nq-measure) + var(--nq-gutter));padding:var(--nq-space-6)";
  page.append(surface.element);
  return { element: page, editor };
}

export const Live: Story = {
  render: () => {
    const container = document.createElement("div");
    const { element } = build();
    container.append(element);
    return container;
  },
  play: async ({ canvasElement }) => {
    // The grid renders with its header row, growth buttons, and the ragged ghost.
    await waitFor(() => expect(canvasElement.querySelector(".nq-table")).not.toBeNull());
    await expect(canvasElement.querySelector(".nq-table-header-row")).not.toBeNull();
    await expect(canvasElement.querySelector(".nq-table-grow-row")).not.toBeNull();
    await expect(canvasElement.querySelector(".nq-table-grow-column")).not.toBeNull();
    await expect(canvasElement.querySelector(".nq-table-ghost")).not.toBeNull();
    // The repair: one click completes the short row (one transaction).
    const before = canvasElement.querySelectorAll("[data-nq-block]").length;
    (canvasElement.querySelector(".nq-table-ghost") as HTMLButtonElement).click();
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block]").length).toBe(before + 1));
    await expect(canvasElement.querySelector(".nq-table-ghost")).toBeNull(); // complete: the ghost retires
    // Growth: one column button click adds a cell to every row.
    (canvasElement.querySelector(".nq-table-grow-column") as HTMLButtonElement).click();
    await waitFor(() => expect(canvasElement.querySelectorAll(".nq-table-cell").length).toBeGreaterThanOrEqual(9)); // 5 + repair(1) + column growth (3 rows × 1)
  },
};
