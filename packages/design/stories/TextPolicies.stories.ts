import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { defineCommand, definePlugin } from "../../plugins/src/index.ts";
import { defineDOMPlugin, defineTextPolicy, type TextMode } from "../../plugins/src/dom.ts";
import { essentials, editText, insertBlock, paragraph, splitBlock } from "../../plugins/src/essentials.ts";
import { callout, callouts } from "../../plugin-callouts/src/index.ts";
import { calloutsDOM } from "../../plugin-callouts/src/dom.ts";

type Args = { mode: TextMode; restricted: boolean; declined: boolean; declinedText: boolean };
const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; paragraph: string; note: string; child: string; unknown: string }>();
const decline = definePlugin({ id: "decline-enter", version: "1.0.0", apiVersion: 1, contributes: { commands: [defineCommand({ ...splitBlock, prepare: () => ({ status: "not-applicable" }) })] } });
const declineText = definePlugin({ id: "decline-text", version: "1.0.0", apiVersion: 1, contributes: { commands: [defineCommand({ ...editText, prepare: () => ({ status: "not-applicable" }) })] } });
const meta = {
  title: "Plugins/Text policies", args: { mode: "rich", restricted: false, declined: false, declinedText: false },
  argTypes: { mode: { control: "select", options: ["plain", "rich"] } },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  render(args) {
    const editor = new Editor({ docId: "text-policy-story", actor: { actorId: "writer" }, plugins: [essentials, callouts, ...(args.declined ? [decline] : []), ...(args.declinedText ? [declineText] : [])],
      resolve: { ...(args.declined ? { [`command:${splitBlock.id}`]: decline.id } : {}), ...(args.declinedText ? { [`command:${editText.id}`]: declineText.id } : {}) },
    }); editors.add(editor);
    const insert = (type: string, text: string, parent: string | null = null) => {
      const result = editor.commands.run(insertBlock, { type, parent }); if (result.status !== "applied") throw new Error(result.status);
      editor.editText(result.selection!.block, text); return result.selection!.block;
    };
    const first = insert(paragraph.type, "Split here"), note = insert(callout.type, "Keep inside"), child = insert(paragraph.type, "Nested text", note);
    editor.setField(note, "future", { preserved: true });
    const unknown = editor.insertBlock({ type: "future.widget/v1", parent: null, text: "Unfamiliar content" }); editor.setField(unknown, "opaque", { keep: true });
    const dom = args.restricted ? defineDOMPlugin({ ...calloutsDOM, views: calloutsDOM.views.map(view => ({ ...view, textPolicy: defineTextPolicy({ defaultMode: "rich", marks: ["em"] }) })) }) : calloutsDOM;
    const surface = createSurface(editor, { plugins: [essentialsDOM, dom], textMode: args.mode }); surface.element.dataset.policyDemo = "true";
    fixtures.set(surface.element, { editor, paragraph: first, note, child, unknown }); return surface.element;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;
function fixture(canvas: HTMLElement) { return fixtures.get(canvas.querySelector<HTMLElement>("[data-policy-demo]")!)!; }
function select(element: HTMLElement, anchor: number, head = anchor) {
  element.focus();
  if (element instanceof HTMLTextAreaElement) { element.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward"); return; }
  const point = (offset: number): [Node, number] => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node = walker.nextNode();
    while (node) { if (offset <= node.textContent!.length) return [node, offset]; offset -= node.textContent!.length; node = walker.nextNode(); }
    return [element, element.childNodes.length];
  };
  const [a, x] = point(anchor), [b, y] = point(head); document.getSelection()!.setBaseAndExtent(a, x, b, y);
}

const mixed: NonNullable<Story["play"]> = async ({ canvas, canvasElement, userEvent, args }) => {
  const note = await canvas.findByRole("textbox", { name: "Callout text" });
  const { editor, paragraph: first, note: id, child } = fixture(canvasElement), roots = [...editor.view.roots];
  await expect(note.tagName).toBe(args.mode === "plain" ? "TEXTAREA" : "DIV");
  select(note, 4); await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(editor.view.blocks[id]!.text!.s).toBe("Keep\n inside"));
  await expect(editor.view.roots).toEqual(roots); await expect(editor.view.blocks[id]!.children).toEqual([child]);
  await expect(editor.view.blocks[id]!.fields.future).toEqual({ preserved: true });
  const text = canvas.getAllByRole("textbox", { name: "Text" })[0]!; select(text, 5); await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(editor.view.roots).toHaveLength(roots.length + 1));
  const next = editor.view.roots[1]!;
  await expect(editor.view.blocks[first]!.text!.s).toBe("Split"); await expect(editor.view.blocks[next]!.text!.s).toBe(" here");
  await expect(canvas.getAllByRole("textbox", { name: "Text" })[1]).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() => expect(editor.view.blocks[next]!.text!.s).toBe("\n here"));
  await expect(editor.view.roots).toHaveLength(roots.length + 1);
};
export const MixedRich: Story = { play: mixed };
export const MixedPlain: Story = { args: { mode: "plain" }, play: mixed };

export const RestrictedFormatting: Story = {
  args: { restricted: true },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Callout text" });
    const { editor, note } = fixture(canvasElement); editor.applyTextChanges(note, [{ retain: 1, setMarks: ["future", "strong"] }]);
    await waitFor(() => expect(text.querySelector("strong")).toHaveTextContent("K"));
    select(text, 0, 4); const revision = editor.revision; await userEvent.keyboard("{Control>}b{/Control}");
    await expect(editor.revision).toBe(revision);
    await userEvent.keyboard("{Control>}i{/Control}");
    await waitFor(() => expect(editor.view.blocks[note]!.text!.marks[0]).toEqual(["em", "future", "strong"]));
    await expect(text.querySelector("em")).not.toBeNull();
  },
};

export const DeclinedSplit: Story = {
  args: { declined: true },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = (await canvas.findAllByRole("textbox", { name: "Text" }))[0]!;
    const { editor, paragraph: id } = fixture(canvasElement); select(text, 5); const revision = editor.revision;
    await userEvent.keyboard("{Enter}"); await expect(editor.revision).toBe(revision);
    await expect(editor.view.blocks[id]!.text!.s).toBe("Split here"); await expect(text).toHaveTextContent("Split here");
  },
};

const declinedReplacement: NonNullable<Story["play"]> = async ({ canvas, canvasElement, userEvent }) => {
  const text = await canvas.findByRole("textbox", { name: "Callout text" });
  const { editor, note } = fixture(canvasElement); select(text, 4, 2); const revision = editor.revision;
  await userEvent.keyboard("{Enter}");
  await expect(editor.revision).toBe(revision); await expect(editor.view.blocks[note]!.text!.s).toBe("Keep inside");
  if (text instanceof HTMLTextAreaElement) {
    await expect(text).toHaveValue("Keep inside");
    await expect([text.selectionStart, text.selectionEnd, text.selectionDirection]).toEqual([2, 4, "backward"]);
  } else {
    await expect(text).toHaveTextContent("Keep inside");
    await expect(document.getSelection()!.toString()).toBe("ep");
    await expect([document.getSelection()!.anchorOffset, document.getSelection()!.focusOffset]).toEqual([4, 2]);
  }
};
export const DeclinedReplacementRich: Story = { args: { declinedText: true }, play: declinedReplacement };
export const DeclinedReplacementPlain: Story = { args: { declinedText: true, mode: "plain" }, play: declinedReplacement };

export const UnknownContent: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Text block" });
    const { editor, unknown } = fixture(canvasElement); await expect(text).toHaveAttribute("contenteditable", "true");
    select(text, 0); await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(editor.view.blocks[unknown]!.text!.s).toBe("\nUnfamiliar content"));
    await expect(editor.view.blocks[unknown]!.fields.opaque).toEqual({ keep: true });
  },
};
