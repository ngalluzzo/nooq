/** The shortcut sheet (foundation P2): collected live from the surface's resolved registry, and the "?" trigger off the input path. */
import "./dom.ts";
import { expect, test } from "bun:test";
import { defineJob, definePlugin } from "@nooq/plugins";
import { defineAction, defineDOMPlugin } from "@nooq/plugins/dom";
import { callouts, cycleTone, insertCallout } from "@nooq/plugin-callouts";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../src/reference.ts";
import { collectShortcuts } from "../src/shortcuts.ts";

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const press = (element: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event); return event;
};

const summarize = defineJob<{ block: string }, string>({ id: "sheet.summarize", label: "Summarize", validateArgs: (a): a is { block: string } => !!a && typeof a === "object" && typeof (a as { block?: unknown }).block === "string",
  async run(_ctx, args) { return args.block; } });
const tools = definePlugin({ id: "sheet.tools", version: "1.0.0", apiVersion: 1, contributes: { jobs: [summarize] } });
const multi = defineAction({ id: "sheet-a", label: "Do A", command: cycleTone, args: ctx => ({ block: ctx.block }), keys: ["F8", "F9"] });
const once = defineAction({ id: "sheet-b", label: "Do B", command: cycleTone, args: ctx => ({ block: ctx.block }), keys: ["F8"] });
const ai = defineAction({ id: "sheet-summarize", label: "Summarize", job: summarize, args: ctx => ({ block: ctx.block }), keys: ["Ctrl+Shift+9"] });

test("the collector enumerates the real registered bindings, grouped by kind, with one row per action", async () => {
  const editor = new Editor({ docId: "shortcuts-collect", actor: { actorId: "writer" }, plugins: [callouts, tools] });
  const inserted = editor.commands.run(insertCallout, { parent: null });
  if (inserted.status !== "applied") throw new Error(inserted.status);
  const id = inserted.selection!.block;
  const dom = defineDOMPlugin({ id: "sheet", forPlugin: callouts, views: [],
    actions: [multi, once, ai],
    keys: [{ id: "sheet-legacy", key: "F10", label: "Legacy jump", command: cycleTone.id, args: ctx => ({ block: ctx.block }) }] });
  const surface = createSurface(editor, { plugins: [dom], keyOrder: { F8: ["sheet-a", "sheet-b"] } });
  document.body.append(surface.element); await settled();

  // Live registry: the collector sees exactly what keyDown dispatches through.
  expect(surface.keymap.get("F8")?.map(binding => binding.id)).toEqual(["sheet-a", "sheet-b"]);
  const groups = collectShortcuts(surface);
  // Plain surface: no rich text chords group.
  expect(groups.map(group => group.title)).toEqual(["Block actions", "Tools"]);
  const entries = groups.flatMap(group => group.entries);
  // One row per action — an action with several keys shows every key, once — and each key string verbatim.
  expect(entries.find(entry => entry.label === "Do A")).toEqual({ label: "Do A", keys: ["F8", "F9"] });
  expect(entries.find(entry => entry.label === "Do B")).toEqual({ label: "Do B", keys: ["F8"] });
  expect(entries.find(entry => entry.label === "Legacy jump")).toEqual({ label: "Legacy jump", keys: ["F10"] });
  expect(groups.find(group => group.title === "Tools")?.entries).toEqual([{ label: "Summarize", keys: ["Ctrl+Shift+9"] }]);
  const labels = entries.map(entry => entry.label);
  expect(new Set(labels).size).toBe(labels.length); // no duplicates
  surface.destroy(); editor.close();
});

test("the reference surface lists its registered bindings and the host's rich text chords", () => {
  const editor = new Editor({ docId: "shortcuts-reference", actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  const groups = collectShortcuts(surface);
  expect(groups.map(group => group.title)).toEqual(["Text editing", "Block actions"]);
  expect(groups[0]!.entries.map(entry => entry.label)).toEqual(["Bold", "Italic", "Code", "Link"]);
  expect(groups[0]!.entries.find(entry => entry.label === "Link")!.keys).toEqual(["Ctrl+K", "Meta+K"]);
  expect(groups[1]!.entries).toContainEqual({ label: "Split block", keys: ["Enter"] });
  surface.destroy(); editor.close();
});

test("typing ? inside a text host keeps typing; ? outside opens the sheet, and ? again or Esc closes it with focus returned", async () => {
  const editor = new Editor({ docId: "shortcuts-trigger", actor: { actorId: "writer" }, plugins: [callouts] });
  const inserted = editor.commands.run(insertCallout, { parent: null });
  if (inserted.status !== "applied") throw new Error(inserted.status);
  const id = inserted.selection!.block;
  editor.editText(id, "hello");
  const dom = defineDOMPlugin({ id: "sheet", forPlugin: callouts, views: [], actions: [multi] });
  const surface = createSurface(editor, { plugins: [dom] });
  document.body.append(surface.element); await settled();
  const host = surface.element.querySelector<HTMLTextAreaElement>("textarea")!;

  // "?" inside the text host is typing: not consumed, no sheet.
  host.focus();
  expect(press(host, "?", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(document.body.querySelector(".nq-shortcuts")).toBeNull();

  // "?" outside the input path (the surface root) opens the reference sheet.
  surface.element.focus();
  expect(document.activeElement).toBe(surface.element);
  expect(press(surface.element, "?", { shiftKey: true }).defaultPrevented).toBe(true);
  const sheet = document.body.querySelector<HTMLElement>(".nq-popover .nq-shortcuts")!;
  expect(sheet.querySelectorAll(".nq-shortcuts-row")).toHaveLength(1);
  expect(sheet.querySelector(".nq-shortcuts-title")!.textContent).toBe("Block actions");
  await flush();
  expect(document.activeElement).toBe(sheet.closest(".nq-popover")); // reference UI may take focus

  // "?" again closes it, focus back on the surface root.
  press(sheet, "?", { shiftKey: true });
  expect(document.body.querySelector(".nq-shortcuts")).toBeNull();
  await flush();
  expect(document.activeElement).toBe(surface.element);

  // Esc closes returning focus too (the popover's contract).
  press(surface.element, "?", { shiftKey: true });
  const open = document.body.querySelector<HTMLElement>(".nq-popover .nq-shortcuts")!;
  await flush();
  press(open, "Escape");
  expect(document.body.querySelector(".nq-popover")).toBeNull();
  expect(document.activeElement).toBe(surface.element);

  surface.destroy(); editor.close();
});
