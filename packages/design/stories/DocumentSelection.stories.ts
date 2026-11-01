import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { NooqRelay, settled } from "../../sync/src/index.ts";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { defineCommand, definePlugin } from "../../plugins/src/index.ts";
import { essentials, editText, insertBlock, paragraph } from "../../plugins/src/essentials.ts";
import { callout, callouts } from "../../plugin-callouts/src/index.ts";
import { calloutsDOM } from "../../plugin-callouts/src/dom.ts";

type Args = { denied: boolean };
const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; relay: NooqRelay; surface: ReturnType<typeof createSurface>; first: string; note: string; child: string; unknown: string }>();
const deny = definePlugin({ id: "declined-range", version: "1.0.0", apiVersion: 1, contributes: { commands: [defineCommand({ ...editText, prepare(ctx, args) {
  return ctx.snapshot.blocks[args.block]!.type === callout.type ? { status: "not-applicable" } : editText.prepare(ctx, args);
} })] } });
const meta = {
  title: "Plugins/Document selection", args: { denied: false },
  beforeEach: () => () => { for (const e of editors) e.close(); editors.clear(); },
  render(args) {
    const relay = new NooqRelay();
    const editor = new Editor({ docId: "selection-story", transport: relay.connect("selection-story"), actor: { actorId: "writer" }, plugins: [essentials, callouts, ...(args.denied ? [deny] : [])],
      ...(args.denied ? { resolve: { "command:nooq.text.edit": deny.id } } : {}),
    }); editors.add(editor);
    const insert = (type: string, text: string, parent: string | null = null) => {
      const result = editor.commands.run(insertBlock, { type, parent }); if (result.status !== "applied") throw new Error(result.status);
      editor.editText(result.selection!.block, text); return result.selection!.block;
    };
    const first = insert(paragraph.type, "Alpha 😀"), note = insert(callout.type, "A callout"), child = insert(paragraph.type, "Nested text", note);
    const unknown = editor.insertBlock({ type: "unfamiliar.note/v2", parent: null, text: "Unknown text", fields: { keep: true } });
    editor.setField(note, "future", { preserve: true });
    const surface = createSurface(editor, { plugins: [essentialsDOM, calloutsDOM], textMode: "rich", selectionMode: "document" });
    const wrapper = document.createElement("section"); wrapper.dataset.documentSelectionDemo = "true";
    const title = document.createElement("h2"); title.textContent = "Select across plugin blocks";
    const help = document.createElement("p"); help.textContent = "Drag between text blocks, extend with Shift+Left/Right, or use Ctrl/⌘+A. Copy excludes controls. Replacing a range keeps each block and its children.";
    const button = document.createElement("button"); button.textContent = "Select paragraph and Callout";
    button.onclick = () => surface.selection!.set({ anchor: { block: first, offset: 2 }, head: { block: note, offset: 5 } });
    wrapper.append(title, help, button, surface.element); fixtures.set(wrapper, { editor, relay, surface, first, note, child, unknown }); return wrapper;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;
function fixture(canvas: HTMLElement) { return fixtures.get(canvas.querySelector<HTMLElement>("[data-document-selection-demo]")!)!; }
const range = (a: string, x: number, h: string, y: number) => ({ anchor: { block: a, offset: x }, head: { block: h, offset: y } });

export const MixedRange: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { surface, first, note } = fixture(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Select paragraph and Callout" }));
    await expect(surface.selection!.text()).toBe("pha 😀\nA cal");
    await expect(surface.selection!.get()).toEqual(range(first, 2, note, 5));
    await expect(document.getSelection()!.isCollapsed).toBe(false);
  },
};
export const ReplaceAcrossBlocks: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const { editor, relay, surface, first, note, child, unknown } = fixture(canvasElement), roots = [...editor.view.roots];
    surface.selection!.set(range(first, 2, unknown, 7)); const before = editor.view.log.length;
    await userEvent.keyboard("X");
    await waitFor(() => expect(editor.view.blocks[first]!.text!.s).toBe("AlX"));
    await expect(editor.view.blocks[note]!.text!.s).toBe(""); await expect(editor.view.blocks[child]!.text!.s).toBe("");
    await expect(editor.view.blocks[unknown]!.text!.s).toBe(" text");
    await expect(editor.view.roots).toEqual(roots); await expect(editor.view.blocks[note]!.children).toEqual([child]);
    await expect(editor.view.blocks[note]!.fields.future).toEqual({ preserve: true }); await expect(editor.view.log.length).toBe(before + 1);
  },
};
export const Formatting: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { editor, surface, first, note } = fixture(canvasElement);
    editor.applyTextChanges(first, [{ retain: 2, setMarks: ["future"] }]);
    await waitFor(() => expect(canvas.getAllByRole("textbox", { name: "Text" })[0]!.querySelector("span[data-nq-marks]")).not.toBeNull());
    surface.selection!.set(range(note, 3, first, 0)); await userEvent.keyboard("{Control>}b{/Control}");
    await waitFor(() => expect(editor.view.blocks[first]!.text!.marks[0]).toEqual(["future", "strong"]));
    await expect(canvas.getByRole("textbox", { name: "Callout text" }).querySelector("strong")).toHaveTextContent("A c");
    await expect(surface.selection!.get()).toEqual(range(note, 3, first, 0));
  },
};
export const DeclinedRange: Story = {
  args: { denied: true },
  play: async ({ canvasElement, userEvent }) => {
    const { editor, surface, first, note } = fixture(canvasElement); surface.selection!.set(range(note, 3, first, 2)); const revision = editor.revision;
    await userEvent.keyboard("{Backspace}"); await expect(editor.revision).toBe(revision);
    await expect(surface.selection!.get()).toEqual(range(note, 3, first, 2)); await expect(surface.selection!.text()).toBe("pha 😀\nA c");
  },
};
export const RemoteRange: Story = {
  play: async ({ canvasElement }) => {
    const { editor, relay, surface, first, note } = fixture(canvasElement);
    const peer = new Editor({ docId: "selection-story", actor: { actorId: "peer" }, transport: relay.connect("selection-story") }); editors.add(peer); await settled();
    surface.selection!.set(range(note, 3, first, 2));
    peer.applyTextChanges(first, [{ insert: "++" }]);
    await waitFor(() => expect(surface.selection!.get()).toEqual(range(note, 3, first, 4)));
    await waitFor(() => expect(document.getSelection()!.focusOffset).toBe(4));
    await expect(surface.selection!.text()).toBe("pha 😀\nA c");
  },
};
export const SelectAllAndCopy: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { surface, first, unknown } = fixture(canvasElement);
    surface.selection!.set(range(first, 0, first, 0)); await userEvent.keyboard("{Control>}a{/Control}");
    await expect(surface.selection!.get()).toEqual(range(first, 0, unknown, 12));
    const data = new DataTransfer(); surface.element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    await expect(data.getData("text/plain")).toBe("Alpha 😀\nA callout\nNested text\nUnknown text");
    await expect(data.getData("text/plain")).not.toContain("Cycle callout tone");
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("textbox", { name: "Text block" })).toHaveFocus();
  },
};
