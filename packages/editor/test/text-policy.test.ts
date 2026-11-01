import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson } from "@nooq/core";
import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";
import { defineDOMPlugin, defineTextPolicy, type DOMPlugin, type TextEditorBinding, type TextMode } from "@nooq/plugins/dom";
import { essentials, editText, insertBlock, paragraph, splitBlock } from "@nooq/plugins/essentials";
import { callout, callouts, insertCallout } from "@nooq/plugin-callouts";
import { calloutsDOM, calloutsPlainDOM } from "@nooq/plugin-callouts/dom";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

function observe(dom: DOMPlugin, bindings: Map<string, TextEditorBinding>) {
  return defineDOMPlugin({ ...dom, views: dom.views.map(view => ({ ...view, mount(ctx) {
    return view.mount({ ...ctx, mountTextEditor(options) { const binding = ctx.mountTextEditor(options); bindings.set(ctx.block, binding); return binding; } });
  } })) });
}
function inserted(e: Editor, type: string, parent: string | null = null) {
  const result = e.commands.run(insertBlock, { type, parent });
  if (result.status !== "applied") throw new Error(result.status);
  return result.selection!.block;
}
async function fixture(mode?: TextMode) {
  const e = new Editor({ docId: "policies", actor: { actorId: "writer" }, plugins: [essentials, callouts] });
  const note = inserted(e, callout.type), child = inserted(e, paragraph.type, note), text = inserted(e, paragraph.type);
  const bindings = new Map<string, TextEditorBinding>();
  const surface = createSurface(e, { plugins: [observe(calloutsDOM, bindings), observe(essentialsDOM, bindings)], textMode: mode });
  document.body.append(surface.element); await settled(); return { e, note, child, text, surface, bindings };
}
function enter(binding: TextEditorBinding, shiftKey = false, isComposing = false) {
  const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey, isComposing, bubbles: true, cancelable: true });
  binding.element.dispatchEvent(event); return event;
}

test("applications select presentation without plugin rewrites or stored-data changes", async () => {
  const { e, note, text, surface, bindings } = await fixture();
  expect(bindings.get(note)!.mode).toBe("rich"); expect(bindings.get(text)!.mode).toBe("plain");
  e.editText(note, "A😀B"); e.applyTextChanges(note, [{ retain: 1 }, { retain: 2, setMarks: ["future", "strong"] }]);
  const before = canonicalJson(e.view); surface.destroy();
  for (const mode of ["plain", "rich"] as const) {
    const s = createSurface(e, { plugins: [observe(calloutsDOM, bindings), observe(essentialsDOM, bindings)], textMode: mode });
    document.body.append(s.element); await settled(); expect(bindings.get(note)!.mode).toBe(mode); expect(bindings.get(text)!.mode).toBe(mode);
    expect(canonicalJson(e.view)).toBe(before); s.destroy();
  }
  expect(bindings.get(note)!.toggleMark("em")).toBe(false); e.close();
});

for (const mode of ["plain", "rich"] as const) {
  test(`${mode}: Callouts keeps Enter local when Writing Basics is installed`, async () => {
    const { e, note, child, bindings } = await fixture(mode), binding = bindings.get(note)!;
    e.editText(note, "hello"); e.setField(note, "future", { keep: true }); await settled(); binding.focus({ anchor: 2, head: 2 });
    const before = e.view.log.length, roots = [...e.view.roots];
    expect(enter(binding).defaultPrevented).toBe(true); await settled();
    expect(e.view.blocks[note]!.text!.s).toBe("he\nllo"); expect(e.view.roots).toEqual(roots); expect(e.view.log).toHaveLength(before + 1);
    expect(e.view.blocks[note]!.children).toEqual([child]); expect(e.view.blocks[note]!.fields.future).toEqual({ keep: true });
    expect(binding.selection()).toEqual({ anchor: 3, head: 3 }); e.close();
  });

  test(`${mode}: Writing Basics splits selected text atomically and preserves the tail's marks`, async () => {
    const { e, text, bindings } = await fixture(mode), binding = bindings.get(text)!;
    e.editText(text, "A😀bc"); e.applyTextChanges(text, [{ retain: 4 }, { retain: 1, setMarks: ["future", "strong"] }]);
    e.setField(text, "future", true); const child = inserted(e, paragraph.type, text); await settled();
    binding.focus({ anchor: 4, head: 1 }); const before = e.view.log.length;
    expect(enter(binding).defaultPrevented).toBe(true); await settled();
    const next = e.view.roots[e.view.roots.indexOf(text) + 1]!;
    expect(e.view.blocks[text]!.text!.s).toBe("A"); expect(e.view.blocks[next]!.text).toEqual({ s: "c", marks: [["future", "strong"]] });
    expect(e.view.blocks[text]!.fields.future).toBe(true); expect(e.view.blocks[text]!.children).toEqual([child]);
    expect(e.view.log).toHaveLength(before + 1); expect(document.activeElement).toBe(bindings.get(next)!.element); e.close();
  });

  test(`${mode}: Shift+Enter and beforeinput line breaks use the same command boundary`, async () => {
    const { e, text, bindings } = await fixture(mode), binding = bindings.get(text)!;
    e.editText(text, "ab"); await settled(); binding.focus({ anchor: 1, head: 1 });
    const roots = [...e.view.roots]; enter(binding, true); await settled(); expect(e.view.blocks[text]!.text!.s).toBe("a\nb"); expect(e.view.roots).toEqual(roots);
    binding.focus({ anchor: 2, head: 2 });
    const soft = new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }); binding.element.dispatchEvent(soft); await settled();
    expect(soft.defaultPrevented).toBe(true); expect(e.view.blocks[text]!.text!.s).toBe("a\n"); expect(e.view.roots.length).toBe(roots.length + 1);
    const fresh = e.view.roots.at(-1)!; expect(e.view.blocks[fresh]!.text!.s).toBe("b");
    const lineBreak = new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true });
    bindings.get(fresh)!.element.dispatchEvent(lineBreak); await settled(); expect(e.view.blocks[fresh]!.text!.s).toBe("\nb"); e.close();
  });

  test(`${mode}: Enter maps selection through admitted remote text before the queued render`, async () => {
    const { e, note, text, bindings } = await fixture(mode);
    e.editText(note, "ab"); e.editText(text, "ab"); await settled();
    const peer = new Editor({ docId: "policies", actor: { actorId: "peer" } }); Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
    for (const id of [note, text]) {
      bindings.get(id)!.focus({ anchor: 1, head: 1 });
      peer.applyTextChanges(id, [{ insert: "++" }]); Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
      // No render/microtask between admission and native input.
      enter(bindings.get(id)!); await settled();
      expect(e.view.blocks[id]!.text!.s).toBe(id === note ? "++a\nb" : "++a");
      if (id === text) expect(e.view.blocks[e.view.roots[e.view.roots.indexOf(id) + 1]!]!.text!.s).toBe("b");
    }
    peer.close(); e.close();
  });

  test(`${mode}: a declined Enter command never falls back to a different edit`, async () => {
    const decline = defineCommand({ ...splitBlock, prepare: () => ({ status: "not-applicable" as const }) });
    const override = definePlugin({ id: "override", version: "1.0.0", apiVersion: 1, contributes: { commands: [decline] } });
    const e = new Editor({ docId: "denied-enter", actor: { actorId: "writer" }, plugins: [essentials, override], resolve: { [`command:${splitBlock.id}`]: override.id } });
    const id = inserted(e, paragraph.type), bindings = new Map<string, TextEditorBinding>(); e.editText(id, "unchanged");
    const s = createSurface(e, { plugins: [observe(essentialsDOM, bindings)], textMode: mode }); document.body.append(s.element); await settled();
    bindings.get(id)!.focus({ anchor: 4, head: 4 }); const before = canonicalJson(e.view);
    expect(enter(bindings.get(id)!).defaultPrevented).toBe(true); expect(canonicalJson(e.view)).toBe(before); e.close();
  });

  test(`${mode}: declined newline edits restore text and the selected range`, async () => {
    const command = defineCommand({ ...editText, prepare: () => ({ status: "not-applicable" as const }) });
    const override = definePlugin({ id: "deny-text", version: "1.0.0", apiVersion: 1, contributes: { commands: [command] } });
    const e = new Editor({ docId: "denied-newline", actor: { actorId: "writer" }, plugins: [essentials, callouts, override], resolve: { [`command:${editText.id}`]: override.id } });
    const id = inserted(e, callout.type), bindings = new Map<string, TextEditorBinding>(); e.editText(id, "unchanged");
    const s = createSurface(e, { plugins: [observe(calloutsDOM, bindings)], textMode: mode }); document.body.append(s.element); await settled();
    const binding = bindings.get(id)!; binding.focus({ anchor: 2, head: 5 }); const before = canonicalJson(e.view);
    enter(binding); await settled(); expect(canonicalJson(e.view)).toBe(before);
    // Denial must leave the original selection available for another action.
    expect(binding.selection()).toEqual({ anchor: 2, head: 5 }); e.close();
  });

  test(`${mode}: composition Enter, remote updates, and deleted bindings cannot split stale targets`, async () => {
    const { e, text, bindings } = await fixture(mode), binding = bindings.get(text)!; e.editText(text, "abc"); await settled();
    binding.focus({ anchor: 2, head: 2 }); const before = e.view.log.length;
    expect(enter(binding, false, true).defaultPrevented).toBe(false); expect(e.view.log).toHaveLength(before);
    const peer = new Editor({ docId: "policies", actor: { actorId: "peer" } }); Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
    peer.applyTextChanges(text, [{ insert: "++" }]); Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(peer.ydoc)); await settled();
    expect(binding.selection()).toEqual({ anchor: 4, head: 4 });
    e.deleteBlock(text); const deleted = canonicalJson(e.view); enter(binding); expect(canonicalJson(e.view)).toBe(deleted);
    e.close(); peer.close(); enter(binding); expect(canonicalJson(e.view)).toBe(deleted);
  });
}

test("rich mark policies prevent unsupported authoring while preserving old and opaque marks", async () => {
  let binding!: TextEditorBinding;
  const dom = defineDOMPlugin({ id: "restricted", forPlugin: callouts, views: [{ type: callout.type,
    textPolicy: defineTextPolicy({ defaultMode: "rich", marks: ["em"] }), mount(ctx) {
      binding = ctx.mountTextEditor(); const element = document.createElement("div"); element.append(binding.element, ctx.children.element); return { element, update() {} };
    },
  }] });
  const e = new Editor({ docId: "marks-policy", actor: { actorId: "writer" }, plugins: [callouts] });
  const result = e.commands.run(insertCallout, { parent: null }); if (result.status !== "applied") throw new Error(result.status);
  const id = result.selection!.block; e.editText(id, "abc"); e.applyTextChanges(id, [{ retain: 1, setMarks: ["future", "strong"] }]);
  const s = createSurface(e, { plugins: [dom] }); document.body.append(s.element); await settled(); binding.focus({ anchor: 0, head: 3 });
  const before = canonicalJson(e.view); expect(binding.toggleMark("strong")).toBe(false);
  const key = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, cancelable: true }); binding.element.dispatchEvent(key);
  const input = new InputEvent("beforeinput", { inputType: "formatBold", cancelable: true }); binding.element.dispatchEvent(input);
  expect(key.defaultPrevented).toBe(true); expect(input.defaultPrevented).toBe(true); expect(canonicalJson(e.view)).toBe(before);
  expect(binding.toggleMark("em")).toBe(true); expect(e.view.blocks[id]!.text!.marks[0]).toEqual(["em", "future", "strong"]); e.close();
});

test("policies validate at composition and explicit legacy bindings retain their presentation", async () => {
  const e = new Editor({ docId: "policy-validation", actor: { actorId: "writer" }, plugins: [essentials, callouts] });
  expect(() => createSurface(e, { textMode: "html" as any })).toThrow("mode");
  const bad = defineDOMPlugin({ ...calloutsDOM, views: calloutsDOM.views.map(view => ({ ...view, textPolicy: defineTextPolicy({ enter: { command: "missing" } }) })) });
  expect(() => createSurface(e, { plugins: [bad] })).toThrow("Unknown Enter command");
  const none = defineBlock({ type: "none", label: "None", text: "none", create: () => ({ fields: {} }), diagnose: () => [] });
  const plugin = definePlugin({ id: "none", version: "1.0.0", apiVersion: 1, contributes: { blocks: [none] } });
  const other = new Editor({ docId: "none", actor: { actorId: "writer" }, plugins: [plugin] });
  expect(() => createSurface(other, { plugins: [defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [{ type: none.type, textPolicy: defineTextPolicy(), mount: () => { throw new Error("Must not mount"); } }] })] })).toThrow("inline"); other.close();
  inserted(e, callout.type); const s = createSurface(e, { plugins: [calloutsPlainDOM], textMode: "rich" }); document.body.append(s.element); await settled();
  expect(s.element.querySelector("textarea")).not.toBeNull(); expect(s.element.querySelector('[contenteditable="true"]')).toBeNull(); e.close();
});
