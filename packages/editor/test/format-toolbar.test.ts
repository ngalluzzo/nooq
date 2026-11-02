/** The formatting toolbar (foundation P1): pointer-only appearance, policy-admitted buttons, and the real mark paths. */
import "./dom.ts";
import { expect, test } from "bun:test";
import { defineBlock, definePlugin } from "@nooq/plugins";
import { defineDOMPlugin, defineTextPolicy } from "@nooq/plugins/dom";
import { deleteBlock, paragraph } from "@nooq/plugins/essentials";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface, type EditorSurface } from "../src/dom.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../src/reference.ts";

/** The policy events, synthesized: a primary-button mouseup as a drag-completed selection leaves it. */
const mouseUp = (element: HTMLElement, button = 0): MouseEvent => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  element.dispatchEvent(event); return event;
};
const key = (element: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event); return event;
};
/** A native selection over character offsets, as a writer's drag would leave it (the links harness). */
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
const stripOf = (surface: EditorSurface): HTMLElement => {
  const strip = surface.element.querySelector<HTMLElement>(".nq-format");
  if (!strip) throw new Error("no format toolbar mounted");
  return strip;
};
const labels = (strip: HTMLElement): string[] => Array.from(strip.querySelectorAll("button")).map(el => el.textContent);

/** One microtask: reconcile runs against the SETTLED selection (real select events are async; the strip waits out the editor's own dispatch). */
const settledSelection = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve));

async function richSurface(docId: string): Promise<{ editor: Editor; surface: EditorSurface; id: string; host: HTMLElement }> {
  const editor = new Editor({ docId, actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  document.body.append(surface.element);
  const id = editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  await settled();
  return { editor, surface, id, host: surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"] .nq-rich-text`)! };
}

test("a pointer selection shows the strip with exactly the permitted buttons; the strip never takes focus", async () => {
  const { editor, surface, host } = await richSurface("format-pointer");
  await settled();
  const strip = stripOf(surface);
  expect(strip.hidden).toBe(true); // nothing is shown before a pointer selection
  expect(strip.getAttribute("role")).toBe("toolbar");
  expect(strip.getAttribute("aria-label")).toBe("Formatting");

  // A non-primary mouseup is not the policy's pointer: nothing shows.
  selectChars(host, 5, 11); mouseUp(host, 2);
  expect(strip.hidden).toBe(true);

  // The policy event: button 0 completing a non-collapsed selection in a rich host.
  mouseUp(host);
  expect(strip.hidden).toBe(false);
  expect(labels(strip)).toEqual(["Bold", "Italic", "Code", "Link"]); // the reference policy admits all four
  for (const button of Array.from(strip.querySelectorAll("button"))) expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(host); // the strip never takes focus
  // The action toolbar's discipline: a button press is prevented, so the selection survives the click.
  const bold = strip.querySelector<HTMLButtonElement>("[data-nq-base='strong']")!;
  const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
  bold.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(host);

  surface.destroy(); editor.close();
});

test("keyboard-only selection never shows the strip; typing never does either", async () => {
  const { editor, surface, host } = await richSurface("format-keyboard");
  await settled();
  const strip = stripOf(surface);
  // Shift+arrows leave exactly this state: a non-collapsed selection made without a pointer.
  selectChars(host, 5, 11);
  host.dispatchEvent(new Event("select", { bubbles: true }));
  host.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
  document.dispatchEvent(new Event("selectionchange"));
  expect(strip.hidden).toBe(true);
  // A collapsed mouseup (a plain click) is a pointer event that completes nothing: no strip.
  selectChars(host, 5, 5); mouseUp(host);
  expect(strip.hidden).toBe(true);

  // Plain hosts carry no marks (0009 §2): their selections never summon it either.
  const plain = new Editor({ docId: "format-plain", actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const plainSurface = createSurface(plain, { plugins: referenceDOM, textMode: "plain" });
  document.body.append(plainSurface.element);
  const pid = plain.insertBlock({ type: paragraph.type, parent: null, text: "Plain words." });
  await settled();
  const area = plainSurface.element.querySelector<HTMLTextAreaElement>(`[data-nq-block="${pid}"] textarea`)!;
  area.focus(); area.setSelectionRange(0, 5); mouseUp(area);
  expect(plainSurface.element.querySelector<HTMLElement>(".nq-format")!.hidden).toBe(true);
  plainSurface.destroy(); plain.close();

  surface.destroy(); editor.close();
});

test("Escape dismisses, and so does a collapsed selection or one that leaves the host", async () => {
  const { editor, surface, host } = await richSurface("format-dismiss");
  await settled();
  const strip = stripOf(surface);
  selectChars(host, 5, 11); mouseUp(host);
  expect(strip.hidden).toBe(false);
  expect(key(host, "Escape").defaultPrevented).toBe(true); // the surface consumes Escape; the strip obeys
  expect(strip.hidden).toBe(true);

  selectChars(host, 0, 4); mouseUp(host); // shows again for a new pointer selection
  expect(strip.hidden).toBe(false);
  // A collapse cannot be synthesized faithfully under happy-dom (its
  // Selection keeps a live range on a focused contenteditable), so the
  // dismissal contract runs through the selection actually going away;
  // real collapse-to-caret is exercised by the browser story suite.
  document.getSelection()!.removeAllRanges();
  host.dispatchEvent(new Event("select", { bubbles: true }));
  await settledSelection();
  expect(strip.hidden).toBe(true);

  selectChars(host, 0, 4); mouseUp(host);
  expect(strip.hidden).toBe(false);
  document.getSelection()!.removeAllRanges(); // the selection left every rich host
  host.dispatchEvent(new Event("select", { bubbles: true }));
  await settledSelection();
  expect(strip.hidden).toBe(true);

  surface.destroy(); editor.close();
});

test("the strip shows only the bases the block's policy admits", async () => {
  const restrictedBlock = defineBlock({ type: "test.restricted/v1", label: "Restricted", text: "inline", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
  const restrictedPlugin = definePlugin({ id: "test.restricted", version: "1.0.0", apiVersion: 1, contributes: { blocks: [restrictedBlock] } });
  const view = (marks: readonly string[]) => defineDOMPlugin({ id: `test.restricted.dom`, forPlugin: restrictedPlugin, views: [{ type: restrictedBlock.type, textPolicy: defineTextPolicy({ defaultMode: "rich", marks }), mount: ctx => {
    const element = document.createElement("div");
    const text = ctx.mountTextEditor({ label: "Restricted text" });
    element.append(text.element, ctx.children.element); // the children container stays retained (the surface's contract)
    return { element, update() {} };
  } }] });
  const editor = new Editor({ docId: "format-restricted", actor: { actorId: "writer" }, plugins: [restrictedPlugin] });
  const surface = createSurface(editor, { plugins: [view(["em", "code"])], textMode: "rich" });
  document.body.append(surface.element);
  const id = editor.insertBlock({ type: restrictedBlock.type, parent: null, text: "Restricted host." });
  await settled();
  const host = surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"] .nq-rich-text`)!;
  const strip = stripOf(surface);
  selectChars(host, 0, 10); mouseUp(host);
  expect(labels(strip)).toEqual(["Italic", "Code"]); // em and code only: no Bold, and no Link the policy never admitted

  surface.destroy();
  // A policy that admits only the payloaded link base: one button, the one entrance Mod-k shares.
  const surface2 = createSurface(editor, { plugins: [view(["link"])], textMode: "rich" });
  document.body.append(surface2.element);
  await settled();
  const host2 = surface2.element.querySelector<HTMLElement>(`[data-nq-block="${id}"] .nq-rich-text`)!;
  selectChars(host2, 0, 10); mouseUp(host2);
  expect(labels(stripOf(surface2))).toEqual(["Link"]);
  surface2.destroy(); editor.close();
});

test("toggle clicks ride the real mark path: the selection keeps, the mark lands, the pressed state tells the truth", async () => {
  const { editor, surface, id, host } = await richSurface("format-toggle");
  await settled();
  const strip = stripOf(surface);
  selectChars(host, 5, 11); mouseUp(host);
  const bold = strip.querySelector<HTMLButtonElement>("[data-nq-base='strong']")!;
  const before = editor.history().length;
  bold.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  mouseUp(bold); bold.click();
  expect(editor.history()).toHaveLength(before + 1); // one real transaction through nooq.text.edit
  const marks = editor.view.blocks[id]!.text!.marks;
  expect(marks.slice(5, 11).every(names => names.includes("strong"))).toBe(true);
  expect(marks.slice(0, 5).every(names => !names.includes("strong"))).toBe(true);
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector("strong")!.textContent).toBe("writes"); // rendered through the same marks path
  expect(document.activeElement).toBe(host); // focus never left the text

  bold.click(); // the second press removes what the first applied
  expect(editor.view.blocks[id]!.text!.marks.every(names => !names.includes("strong"))).toBe(true);
  expect(bold.getAttribute("aria-pressed")).toBe("false");

  // The strip never intercepts typing (§3): the chord still works while it is shown.
  selectChars(host, 0, 4); mouseUp(host);
  expect(strip.hidden).toBe(false);
  key(host, "b", { metaKey: true });
  expect(editor.view.blocks[id]!.text!.marks.slice(0, 4).every(names => names.includes("strong"))).toBe(true);
  await settledSelection(); // the strip refreshes against the restored selection
  expect(strip.querySelector<HTMLButtonElement>("[data-nq-base='strong']")!.getAttribute("aria-pressed")).toBe("true");

  surface.destroy(); editor.close();
});

test("the Link button opens the Mod-k popover, and shows pressed over a linked selection", async () => {
  const { editor, surface, id, host } = await richSurface("format-link");
  await settled();
  const strip = stripOf(surface);
  selectChars(host, 5, 11); mouseUp(host);
  const link = strip.querySelector<HTMLButtonElement>("[data-nq-base='link']")!;
  expect(link.getAttribute("aria-pressed")).toBe("false");
  link.click();
  // The SAME flow as Mod-k: one popover, one href field, focus in it (0009 §5).
  const input = document.body.querySelector<HTMLInputElement>(".nq-popover input")!;
  expect(document.body.querySelector<HTMLElement>(".nq-popover .nq-field-label")!.textContent).toBe("Link destination");
  expect(document.activeElement).toBe(input);
  input.value = "https://nooq.dev";
  key(input, "Enter"); await settled();
  expect(host.querySelector("a.nq-link")!.getAttribute("href")).toBe("https://nooq.dev");
  expect(editor.view.blocks[id]!.text!.s).toBe("Maya writes in ink."); // the link is the only change

  // A pointer selection of the linked span reports the link as active.
  selectChars(host, 5, 11); mouseUp(host);
  expect(strip.querySelector<HTMLButtonElement>("[data-nq-base='link']")!.getAttribute("aria-pressed")).toBe("true");
  expect(strip.querySelector<HTMLButtonElement>("[data-nq-base='strong']")!.getAttribute("aria-pressed")).toBe("false");

  surface.destroy(); editor.close();
});

test("destroy tears the strip down with the surface, and a deleted block's row never keeps it", async () => {
  const { editor, surface, id, host } = await richSurface("format-destroy");
  await settled();
  const strip = stripOf(surface);
  selectChars(host, 0, 4); mouseUp(host);
  expect(strip.hidden).toBe(false);
  const outcome = editor.commands.run(deleteBlock, { block: id });
  expect(outcome.status).toBe("applied");
  await settled(2); // the row's cleanup hides the strip shown for its block
  expect(strip.hidden).toBe(true);
  surface.destroy();
  expect(strip.isConnected).toBe(false);
  editor.close();
});
