import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { defineCommand, definePlugin } from "../../plugins/src/index.ts";
import { deleteBlock, essentials, paragraph } from "../../plugins/src/essentials.ts";
import { callout, callouts } from "../../plugin-callouts/src/index.ts";
import { calloutsDOM } from "../../plugin-callouts/src/dom.ts";

type Args = { denied: boolean; nested: boolean };
const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; surface: ReturnType<typeof createSurface>; first: string; middle: string; last: string; note: string }>();
const range = (a: string, x: number, b: string, y: number) => ({ anchor: { block: a, offset: x }, head: { block: b, offset: y } });
const meta = {
  title: "Plugins/Structural merging", args: { denied: false, nested: false },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  render(args) {
    let last = "";
    const deny = definePlugin({ id: "merge-guard", version: "1.0.0", apiVersion: 1, contributes: { commands: [defineCommand({ ...deleteBlock,
      prepare: (ctx, input) => input.block === last ? { status: "not-applicable" } : deleteBlock.prepare(ctx, input),
    })] } });
    const editor = new Editor({ docId: "merge-story", actor: { actorId: "human:writer" }, plugins: [essentials, callouts, ...(args.denied ? [deny] : [])],
      ...(args.denied ? { resolve: { "command:nooq.block.delete": deny.id } } : {}),
    }); editors.add(editor);
    const note = editor.insertBlock({ type: callout.type, parent: null, text: "Protected callout", fields: { tone: "info" } });
    const insert = (text: string, index: number) => editor.insertBlock({ type: paragraph.type, parent: args.nested ? note : null, text, index });
    const first = insert("Alpha 😀", 0), middle = insert("Middle", 1); last = insert("Omega", 2);
    editor.applyTextChanges(last, [{ retain: 2 }, { retain: 3, setMarks: ["em", "future"] }]);
    const surface = createSurface(editor, { plugins: [essentialsDOM, calloutsDOM], textMode: "rich", selectionMode: "document" });
    const wrapper = document.createElement("section"); wrapper.dataset.structuralMergingDemo = "true";
    const title = document.createElement("h2"); title.textContent = "Join compatible text blocks";
    const help = document.createElement("p"); help.textContent = "Select across paragraphs and type, cut, or paste to join them. Backspace at the start and Delete at the end also join neighboring paragraphs. Callouts and blocks with children stay separate.";
    const select = document.createElement("button"); select.textContent = "Select three paragraphs"; select.onclick = () => surface.selection!.set(range(first, 2, last, 2));
    const boundary = document.createElement("button"); boundary.textContent = "Place caret at second paragraph start"; boundary.onclick = () => surface.selection!.set(range(middle, 0, middle, 0));
    wrapper.append(title, help, select, boundary, surface.element); fixtures.set(wrapper, { editor, surface, first, middle, last, note }); return wrapper;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;
const fixture = (canvas: HTMLElement) => fixtures.get(canvas.querySelector<HTMLElement>("[data-structural-merging-demo]")!)!;

export const ReadyToMerge: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Select three paragraphs" }));
    await expect(document.getSelection()!.getRangeAt(0).toString()).toContain("Middle");
  },
};
export const MergeRange: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, surface, first, note } = fixture(canvasElement), before = editor.history().length;
    await userEvent.click(canvas.getByRole("button", { name: "Select three paragraphs" })); await userEvent.keyboard("X");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Text" })).toHaveTextContent("AlXega"));
    await expect(editor.view.roots).toEqual([first, note]); await expect(editor.history().length).toBe(before + 1);
    await expect(editor.view.blocks[first]!.text!.marks[3]).toEqual(["em", "future"]);
    await expect(surface.selection!.get()).toEqual(range(first, 3, first, 3));
    await userEvent.keyboard("!"); await waitFor(() => expect(editor.view.blocks[first]!.text!.s).toBe("AlX!ega"));
  },
};
export const BackspaceAtBoundary: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, surface, first, last, note } = fixture(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Place caret at second paragraph start" })); await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(editor.view.roots).toEqual([first, last, note]));
    await expect(canvas.getAllByRole("textbox", { name: "Text" })[0]).toHaveTextContent("Alpha 😀Middle");
    await expect(surface.selection!.get()).toEqual(range(first, 8, first, 8));
  },
};
export const NestedSiblings: Story = {
  args: { nested: true },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, first, note } = fixture(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Select three paragraphs" })); await userEvent.keyboard("{Delete}");
    await waitFor(() => expect(editor.view.blocks[note]!.children).toEqual([first]));
    await expect(canvas.getByRole("textbox", { name: "Callout text" })).toHaveTextContent("Protected callout");
    await expect(canvas.getByRole("textbox", { name: "Text" })).toHaveTextContent("Alega");
  },
};
export const DeclinedMerge: Story = {
  args: { denied: true },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, surface, first, last } = fixture(canvasElement), revision = editor.revision;
    await userEvent.click(canvas.getByRole("button", { name: "Select three paragraphs" })); await userEvent.keyboard("{Backspace}");
    await expect(editor.revision).toBe(revision); await expect(surface.selection!.get()).toEqual(range(first, 2, last, 2));
    await expect(canvas.getAllByRole("textbox", { name: "Text" })).toHaveLength(3);
  },
};
export const CustomBlockBarrier: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, surface, last, note } = fixture(canvasElement), roots = [...editor.view.roots];
    surface.selection!.set(range(note, 0, note, 0)); await userEvent.keyboard("{Backspace}");
    await expect(editor.view.roots).toEqual(roots); await expect(editor.view.blocks[last]!.text!.s).toBe("Omega");
    await expect(canvas.getByRole("textbox", { name: "Callout text" })).toHaveTextContent("Protected callout");
  },
};
