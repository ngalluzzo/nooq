import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { applyTextChanges, canonicalJson } from "@nooq/core";
import { defineBlockSchema, field, definePlugin, defineCommand } from "@nooq/plugins";
import { defineDOMPlugin, type RichTextBinding } from "@nooq/plugins/dom";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { richTextChanges, rebaseTextChanges } from "../src/rich-text.ts";
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const note = defineBlockSchema({ type: "test.rich/v1", label: "Rich", text: "inline", fields: { tone: field.string("info") } });
const plugin = definePlugin({ id: "test.rich", version: "1.0.0", apiVersion: 1, contributes: { blocks: [note] } });

test("mark-aware diffs use UTF-16 offsets, including emoji and combining characters", () => {
  const before = { s: "A😀éB", marks: Array.from({ length: 6 }, () => [] as string[]) };
  const after = { s: "A😀é!B", marks: [[], ["strong"], ["strong"], [], [], ["em"], []] };
  expect(applyTextChanges(before, richTextChanges(before, after))).toEqual(after);
  expect(richTextChanges(before, before)).toEqual([]);
  const rebased = applyTextChanges({ s: "++ab😀c", marks: Array.from({ length: 7 }, () => []) }, rebaseTextChanges([{ retain: 4 }, { insert: "あ" }], "ab😀c", "++ab😀c"));
  expect(rebased.s).toBe("++ab😀あc"); expect(rebased.marks).toHaveLength(rebased.s.length);
});

test("plugin rich text retains unknown marks, maps remote carets, and survives moves/field edits", async () => {
  let binding: RichTextBinding;
  const dom = defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [{ type: note.type, mount(ctx) {
    binding = ctx.mountRichText({ label: "Rich note" }); const element = document.createElement("aside"); element.append(binding.element, ctx.children.element);
    return { element, update() {} };
  } }] });
  const a = new Editor({ docId: "rich", actor: { actorId: "writer" }, plugins: [plugin] });
  const b = new Editor({ docId: "rich", actor: { actorId: "peer" } });
  const id = a.insertBlock({ type: note.type, parent: null, text: "A😀B" });
  a.applyTextChanges(id, [{ retain: 1 }, { retain: 2, setMarks: ["future"] }]);
  const surface = createSurface(a, { plugins: [dom] }); document.body.append(surface.element); await flush();
  const text = binding!.element; expect(text.getAttribute("contenteditable")).toBe("true");
  binding!.focus({ anchor: 1, head: 3 }); const before = a.view.log.length;
  expect(binding!.toggleMark("strong")).toBe(true); await flush();
  expect(a.view.log).toHaveLength(before + 1); expect(a.view.blocks[id]!.text!.marks).toEqual([[], ["future", "strong"], ["future", "strong"], []]);
  expect(text.querySelector("strong")!.textContent).toBe("😀");
  // Native selection can move before the asynchronous selectionchange observer.
  binding!.focus({ anchor: 0, head: 0 });
  const native = document.createRange(); native.selectNodeContents(text.querySelector("strong")!);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(native);
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc)); b.applyTextChanges(id, [{ insert: "++" }]); Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc)); await flush();
  expect(binding!.selection()).toEqual({ anchor: 3, head: 5 }); expect(text.textContent).toBe("++A😀B");
  const container = a.insertBlock({ type: "unknown/container", parent: null }); a.moveBlock(id, container); a.setField(id, "tone", "warning"); await flush();
  expect(binding!.element).toBe(text); expect(binding!.selection()).toEqual({ anchor: 3, head: 5 });
  a.deleteBlock(id); const afterDelete = canonicalJson(a.view);
  expect(binding!.toggleMark("em")).toBe(false); expect(canonicalJson(a.view)).toBe(afterDelete);
  a.close(); const state = canonicalJson(a.view); expect(binding!.toggleMark("em")).toBe(false); binding!.destroy(); expect(canonicalJson(a.view)).toBe(state); b.close();
});

test("rich text obeys selected text commands and rolls back declined mutations", async () => {
  let binding: RichTextBinding;
  const deny = defineCommand<{ block: string }>({ id: "nooq.text.edit", label: "Read only", validateArgs: (a): a is { block: string } => !!a && typeof a === "object", prepare: () => ({ status: "not-applicable" }) });
  const editor = new Editor({ docId: "denied-rich", actor: { actorId: "writer" }, plugins: [plugin, definePlugin({ id: "deny", version: "1.0.0", apiVersion: 1, contributes: { commands: [deny] } })] });
  const id = editor.insertBlock({ type: note.type, parent: null, text: "text" });
  const dom = defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [{ type: note.type, mount(ctx) { binding = ctx.mountRichText(); const element = document.createElement("div"); element.append(binding.element, ctx.children.element); return { element, update() {} }; } }] });
  const surface = createSurface(editor, { plugins: [dom] }); document.body.append(surface.element); await flush();
  binding!.focus({ anchor: 0, head: 4 }); const before = canonicalJson(editor.view);
  expect(binding!.toggleMark("strong")).toBe(false); expect(binding!.element.querySelector("strong")).toBeNull(); expect(canonicalJson(editor.view)).toBe(before);
  editor.close();
});
