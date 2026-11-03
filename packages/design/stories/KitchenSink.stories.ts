import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor } from "../../editor/src/index.ts";
import { createSurface } from "../../editor/src/dom.ts";
import { referenceDOM, referencePlugins, referenceJobBindings } from "../../editor/src/reference.ts";
import { essentials } from "../../plugins/src/essentials.ts";
import { tablesPlugin, addRowAfter, insertTable, addColumn, toggleHeaderRow } from "../../plugin-tables/src/index.ts";
import { tablesDOM } from "../../plugin-tables/src/dom.ts";
import { codePlugin } from "../../plugin-code/src/index.ts";
import { codeDOM } from "../../plugin-code/src/dom.ts";
import { mathPlugin } from "../../plugin-math/src/index.ts";
import { mathDOM } from "../../plugin-math/src/dom.ts";
import { imagePlugin } from "../../plugin-image/src/index.ts";
import { imageDOM } from "../../plugin-image/src/dom.ts";
import { diagramPlugin } from "../../plugin-diagram/src/index.ts";
import { diagramDOM } from "../../plugin-diagram/src/dom.ts";

/**
 * The kitchen sink (the surface-sprint showcase): one live document holding
 * EVERY block type the last weeks shipped — headings by level, the three
 * list kinds with nesting, quote, divider, code (highlighted, language
 * picked), math (rendered live), an image (caption-as-text), a Mermaid
 * diagram, and a table (headers, growth buttons, a ragged row drawn
 * honestly). The drag handle, the slash menu, and paste work here because
 * this is the real surface, not a mock.
 */

const meta = {
  title: "Surface/Kitchen sink",
  parameters: {
    docs: {
      description: {
        component:
          "The whole reference editor with every shipped block type in one document. Interactive: type, slash, drag, paste — it is the product, not a picture of it.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

function build(): { element: HTMLElement; editor: Editor } {
  const editor = new Editor({ docId: "kitchen-sink", actor: { actorId: "human:you", name: "You" }, jobBindings: referenceJobBindings(), plugins: [...referencePlugins, codePlugin, mathPlugin, imagePlugin, diagramPlugin] }); // referencePlugins carries essentials + review + rewrite + tables
  const insert = (type: string, text: string, fields: Record<string, import("@nooq/core").JsonValue> = {}): string => editor.insertBlock({ type, parent: null, text, fields });
  insert("nooq.title/v1", "The kitchen sink");
  insert("nooq.heading/v1", "Headings carry levels", { level: 1 });
  insert("nooq.paragraph/v1", "A paragraph with **strong**, *emphasis*, and `code` shapes — the marks the model keeps per character.");
  insert("nooq.heading/v1", "Lists, all three kinds", { level: 2 });
  const bullet = insert("nooq.list/v1", "Bullets nest", { kind: "bullet" });
  editor.insertBlock({ type: "nooq.list/v1", parent: bullet, text: "Nested under the first", fields: { kind: "bullet" } });
  insert("nooq.list/v1", "Numbered renumber on remote inserts", { kind: "number" });
  insert("nooq.list/v1", "To-dos are one undoable field write", { kind: "check" });
  insert("nooq.list/v1", "Done ones carry the check", { kind: "check", checked: true });
  insert("nooq.divider/v1", "");
  insert("nooq.quote/v1", "A quote, the third text kind.");
  insert("nooq.code/v1", "const nooq = { open: true, budgets: \"enforced\" };", { lang: "ts" });
  insert("nooq.math/v1", "\\frac{a}{b} + \\int_0^1 x\\,dx = \\text{math renders live}");
  insert("nooq.diagram/v1", "flowchart LR\n  A[Markdown in] --> B{nooq}\n  B --> C[Blocks out]\n  B --> D[SVG beneath]");
  insert("nooq.image/v1", "A caption is ordinary text — signed and attributed", { src: "https://placehold.co/640x360/f2f0e5/555b6a?text=nooq" });
  // The table: headers, two rows, then a ragged third drawn honestly
  editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
  const anchor = editor.view.roots.at(-1)!;
  editor.commands.run(insertTable, { parent: null, index: editor.view.roots.length });
  const tableId = editor.view.roots.at(-1)!;
  void anchor; void tableId;
  const rows = editor.view.blocks[editor.view.roots.at(-1)!]!.children as string[];
  const first = rows[0]!, second = rows[1]!;
  const cellsOf = (row: string): string[] => editor.view.blocks[row]!.children as string[];
  cellsOf(first).forEach((cell, i) => editor.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: `Header ${i + 1}` }] }));
  cellsOf(second).forEach((cell, i) => editor.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: `row one, col ${i + 1}` }] }));
  editor.commands.run(toggleHeaderRow, { row: first });
  editor.commands.run(addRowAfter, { afterRow: second });
  const third = (editor.view.blocks[editor.view.roots.at(-1)!]!.children as string[])[2]!;
  editor.commands.run("nooq.text.edit", { block: (editor.view.blocks[third]!.children as string[])[0]!, changes: [{ insert: "short row" }] });
  editor.commands.run("nooq.block.delete", { block: (editor.view.blocks[third]!.children as string[])[1]! }); // ragged, drawn
  editor.commands.run(addColumn, { table: editor.view.roots.at(-1)! });
  const surface = createSurface(editor, { plugins: [...referenceDOM, codeDOM, mathDOM, imageDOM(), diagramDOM] }); // referenceDOM carries tables; imageDOM is the host-options factory
  const page = document.createElement("div");
  page.style.cssText = "display:flex;flex-direction:column;gap:var(--nq-space-6);max-width:calc(var(--nq-measure) + var(--nq-gutter));padding:var(--nq-space-6)";
  page.append(surface.element);
  return { element: page, editor };
}

export const EveryBlockType: Story = {
  render: () => {
    const container = document.createElement("div");
    const { element } = build();
    container.append(element);
    return container;
  },
  play: async ({ canvasElement }) => {
    // Every shipped type renders in the live surface.
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block]").length).toBeGreaterThanOrEqual(15));
    await expect(canvasElement.querySelector(".nq-drop-indicator, .nq-handle")).toBeDefined(); // the grip ships in every gutter
    await waitFor(() => expect(canvasElement.querySelector(".nq-table")).not.toBeNull()); // the table
    await expect(canvasElement.querySelector(".nq-table-ghost")).not.toBeNull(); // the ragged row, drawn honestly
    await waitFor(() => { expect(canvasElement.querySelector(".nq-math-render")?.childElementCount ?? 0).toBeGreaterThan(0); }); // KaTeX rendered
    await waitFor(() => { expect(canvasElement.querySelector(".nq-diagram-render")?.childElementCount ?? 0).toBeGreaterThan(0); }); // pele rendered
  },
};
