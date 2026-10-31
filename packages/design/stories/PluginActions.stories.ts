import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, insertBlock } from "../../plugins/src/essentials.ts";
import { callout, callouts, insertCallout } from "../../plugin-callouts/src/index.ts";
import { calloutsDOM } from "../../plugin-callouts/src/dom.ts";

type Args = { tone: string };
const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; id: string }>();
const meta = {
  title: "Plugins/Shared actions",
  args: { tone: "info" },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  render(args) {
    const editor = new Editor({ docId: "action-story", actor: { actorId: "writer" }, plugins: [essentials, callouts] });
    editors.add(editor);
    const inserted = editor.commands.run(insertCallout, { parent: null });
    if (inserted.status !== "applied") throw new Error(inserted.status);
    const id = inserted.selection!.block;
    editor.editText(id, "A useful note"); editor.setField(id, "tone", args.tone); editor.setField(id, "future", { preserved: true });
    const surface = createSurface(editor, { plugins: [calloutsDOM, essentialsDOM] });
    surface.element.dataset.actionDemo = "true";
    fixtures.set(surface.element, { editor, id });
    return surface.element;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;
function fixture(canvas: HTMLElement) { return fixtures.get(canvas.querySelector<HTMLElement>("[data-action-demo]")!)!; }

export const ToolbarAndShortcut: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Callout text" });
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    const { editor, id } = fixture(canvasElement), before = editor.view.log.length;
    await userEvent.click(button);
    await expect(canvas.getByText("Tone: warning")).toBeVisible();
    await userEvent.click(text);
    await userEvent.keyboard("{Control>}{Shift>}Y{/Shift}{/Control}");
    await expect(canvas.getByText("Tone: success")).toBeVisible();
    await expect(editor.view.log.length).toBe(before + 2);
    await expect(editor.view.blocks[id]!.fields.future).toEqual({ preserved: true });
    await expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBe(button);
  },
};

export const DisabledAndRecovery: Story = {
  args: { tone: "future-tone" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const button = await canvas.findByRole("button", { name: "Cycle callout tone" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("Choose a supported tone before cycling.");
    const { editor, id } = fixture(canvasElement);
    await userEvent.click(canvas.getByRole("textbox", { name: "Callout text" }));
    await userEvent.keyboard("{Control>}{Shift>}Y{/Shift}{/Control}");
    await expect(editor.view.blocks[id]!.fields.tone).toBe("future-tone");
    editor.setField(id, "tone", "info");
    await waitFor(() => expect(button).toBeEnabled());
    button.focus(); await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("Tone: warning")).toBeVisible();
  },
};

export const ToolbarPreservesSelection: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Callout text" });
    text.focus();
    const range = document.createRange(); range.setStart(text.firstChild!, 2); range.setEnd(text.firstChild!, 8);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    await userEvent.click(canvas.getByRole("button", { name: "Cycle callout tone" }));
    await expect(text).toHaveFocus(); await expect(selection.toString()).toBe("useful");
    await userEvent.keyboard("{Control>}b{/Control}");
    const { editor, id } = fixture(canvasElement), marks = editor.view.blocks[id]!.text!.marks;
    await expect(text.querySelector("strong")).toHaveTextContent("useful");
    await expect(marks.slice(2, 8).every(mark => mark.includes("strong"))).toBe(true);
    await expect(marks[0]).not.toContain("strong");
  },
};

export const SlashInsertion: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("textbox", { name: "Callout text" });
    const { editor, id } = fixture(canvasElement);
    const source = editor.commands.run(insertBlock, { type: "nooq.paragraph/v1", parent: id });
    if (source.status !== "applied") throw new Error(source.status);
    const text = await canvas.findByRole("textbox", { name: "Text" });
    await userEvent.type(text, "/");
    await userEvent.click(canvas.getByRole("option", { name: /Callout/ }));
    await waitFor(() => expect(canvas.getAllByRole("textbox", { name: "Callout text" })).toHaveLength(2));
    await expect(editor.view.blocks[source.selection!.block]!.text!.s).toBe("");
    await expect(editor.view.blocks[editor.view.blocks[id]!.children[1]!]!.type).toBe(callout.type);
  },
};

export const StaleTarget: Story = {
  play: async ({ canvas, canvasElement }) => {
    const button = await canvas.findByRole("button", { name: "Cycle callout tone" });
    const { editor, id } = fixture(canvasElement);
    editor.deleteBlock(id);
    const revision = editor.revision;
    button.click();
    await expect(editor.revision).toBe(revision);
    await expect(editor.view.blocks[id]!.fields.tone).toBe("info");
    editor.restoreBlock(id, null);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Cycle callout tone" })).toBeEnabled());
  },
};
