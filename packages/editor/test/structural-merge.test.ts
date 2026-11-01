import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, createActorKey, createSecuredDocument, liveTree, toBase64 } from "@nooq/core";
import { defineBlock, defineBlockSchema, defineCommand, definePlugin, type Command, type CommandContext, type DocumentTextSelection, type Plugin } from "@nooq/plugins";
import { essentials, paragraph, heading, quote, editText, deleteBlock, mergeText } from "@nooq/plugins/essentials";
import { callout, callouts } from "@nooq/plugin-callouts";
import { calloutsDOM } from "@nooq/plugin-callouts/dom";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

const range = (a: string, from: number, b: string, to: number): DocumentTextSelection => ({ anchor: { block: a, offset: from }, head: { block: b, offset: to } });
const key = (target: HTMLElement, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event;
};
function editor(extra?: Plugin) {
  return new Editor({ docId: "structural-merge", actor: { actorId: "writer" }, plugins: [essentials, callouts, ...(extra ? [extra] : [])],
    ...(extra ? { resolve: Object.fromEntries((extra.contributes.commands ?? []).filter(c => essentials.contributes.commands.some(e => e.id === c.id)).map(c => [`command:${c.id}`, extra.id])) } : {}),
  });
}
function add(e: Editor, text: string, type = paragraph.type, parent: string | null = null) {
  return e.insertBlock({ type, parent, text });
}
async function mount(e: Editor) {
  const surface = createSurface(e, { plugins: [essentialsDOM, ...(e.registry.block(callout.type) ? [calloutsDOM] : [])], textMode: "rich", selectionMode: "document" });
  document.body.append(surface.element); await settled(); return surface;
}
function overrides(commands: Command<any>[]) { return definePlugin({ id: "merge-override", version: "1.0.0", apiVersion: 1, contributes: { commands } }); }

test("forward and backward multi-block replacement merge once, preserving suffix marks, identity, fields, and peer state", async () => {
  for (const backwards of [false, true]) {
    const e = editor(), a = add(e, "A😀B"), b = add(e, "middle"), c = add(e, "end🦉!");
    for (const id of [a, b, c]) e.setField(id, "future", { keep: true });
    e.applyTextChanges(a, [{ retain: 1, setMarks: ["strong"] }]);
    e.applyTextChanges(c, [{ retain: 3 }, { retain: 2, setMarks: ["em", "future"] }]);
    const peer = editor(); Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
    const original = structuredClone(e.view.blocks[c]!), surface = await mount(e), selected = backwards ? range(c, 3, a, 3) : range(a, 3, c, 3);
    surface.selection!.set(selected); const revision = e.view.log.length;
    expect(surface.selection!.replace("X").status).toBe("applied"); await settled();
    expect(e.view.roots).toEqual([a]); expect(e.view.blocks[a]!.text).toEqual({ s: "A😀X🦉!", marks: [["strong"], [], [], [], ["em", "future"], ["em", "future"], []] });
    expect(e.view.blocks[a]!.fields).toEqual({ future: { keep: true } }); expect(e.view.blocks[c]).toEqual(original);
    expect(e.view.log.length).toBe(revision + 1); expect(e.view.log.at(-1)!.intent).toBe("merge-text");
    expect(e.view.log.at(-1)!.actor.plugin).toBe(essentials.id); expect(surface.selection!.get()).toEqual(range(a, 4, a, 4));
    expect(surface.element.querySelectorAll('[role="textbox"]')).toHaveLength(1);
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc)); expect(canonicalJson(e.view)).toBe(canonicalJson(peer.view));
    peer.close(); e.close();
  }
});

test("same-type nested leaf siblings merge without changing their parent or neighboring siblings", async () => {
  for (const type of [paragraph.type, heading.type, quote.type]) {
    const e = editor(), parent = add(e, "container", callout.type), a = add(e, "left", type, parent), b = add(e, "right", type, parent), untouched = add(e, "after", type, parent);
    const surface = await mount(e); surface.selection!.set(range(a, 4, b, 0));
    expect(surface.selection!.merge().status).toBe("applied"); await settled();
    expect(e.view.blocks[parent]!.children).toEqual([a, untouched]); expect(e.view.blocks[a]!.text!.s).toBe("leftright");
    expect(e.view.roots).toEqual([parent]); expect(e.view.blocks[untouched]!.text!.s).toBe("after"); e.close();
  }
});

test("compatibility is opt-in and checks fields, direct siblings, descendants, and current liveness", async () => {
  for (const kind of ["type", "fields", "children", "parent", "nontext", "unknown", "optout", "stale"] as const) {
    const e = editor(), a = add(e, "left", kind === "optout" ? callout.type : paragraph.type), b = add(e, "right", kind === "optout" ? callout.type : kind === "type" ? heading.type : kind === "unknown" ? "future/v1" : paragraph.type);
    if (kind === "fields") e.setField(b, "future", "do not discard");
    if (kind === "children") add(e, "protected child", paragraph.type, b);
    if (kind === "parent") e.moveBlock(b, a);
    if (kind === "nontext") e.insertBlock({ type: "widget/v1", parent: null, index: 1 });
    if (kind === "stale") e.deleteBlock(b);
    const before = canonicalJson(e.view);
    expect(e.commands.run(mergeText, { range: range(a, 2, b, 2), text: "X" }).status).toBe("not-applicable");
    expect(canonicalJson(e.view)).toBe(before); e.close();
  }
  expect(() => defineBlock({ ...paragraph, text: "none" })).toThrow("merge policy");
  const custom = defineBlockSchema({ type: "custom/v1", label: "Custom", text: "inline", textMerge: "same-type", fields: {} });
  const plugin = definePlugin({ id: "custom", version: "1.0.0", apiVersion: 1, contributes: { blocks: [custom] } });
  const e = editor(plugin), a = add(e, "custom ", custom.type), b = add(e, "text", custom.type);
  expect(e.commands.run(mergeText, { range: range(a, 7, b, 0), text: "" }).status).toBe("applied");
  expect(e.view.blocks[a]!.text!.s).toBe("custom text"); e.close();
});

test("explicit incompatible merges decline; mixed replacement still preserves structure", async () => {
  const e = editor(), a = add(e, "left"), b = add(e, "callout", callout.type), child = add(e, "child", paragraph.type, b), surface = await mount(e);
  surface.selection!.set(range(a, 2, b, 2)); const before = canonicalJson(e.view);
  expect(surface.selection!.merge("X").status).toBe("not-applicable"); expect(canonicalJson(e.view)).toBe(before);
  expect(surface.selection!.replace("X").status).toBe("applied");
  expect(e.view.roots).toEqual([a, b]); expect(e.view.blocks[b]!.children).toEqual([child]); expect(e.view.blocks[b]!.text!.s).toBe("llout"); e.close();
});

test("selected text and delete providers can refuse without partial writes or text-only fallback", async () => {
  for (const mode of ["text-decline", "text-transform", "delete-decline", "delete-throw", "delete-extra", "merge-decline"] as const) {
    let last = "", calls: string[] = [];
    const feature = overrides([
      defineCommand({ ...editText, prepare(ctx, args) {
        calls.push(`text:${ctx.actor.plugin}`);
        if (mode === "text-decline") return { status: "not-applicable" };
        if (mode === "text-transform") return editText.prepare(ctx, { ...args, changes: [{ insert: "transformed" }] });
        return editText.prepare(ctx, args);
      } }),
      defineCommand({ ...deleteBlock, prepare(ctx, args) {
        calls.push(`delete:${ctx.actor.plugin}`);
        if (args.block === last) {
          if (mode === "delete-decline") return { status: "not-applicable" };
          if (mode === "delete-throw") throw new Error("last deletion refused");
          if (mode === "delete-extra") return { status: "ready", intent: "unexpected", ops: [{ op: "delete", block: args.block }, { op: "setField", block: args.block, key: "unexpected", value: true }] };
        }
        return deleteBlock.prepare(ctx, args);
      } }),
      ...(mode === "merge-decline" ? [defineCommand({ ...mergeText, prepare: () => ({ status: "not-applicable" as const }) })] : []),
    ]);
    const e = editor(feature), a = add(e, "left"), b = add(e, "middle"); last = add(e, "right");
    const surface = await mount(e), selected = range(last, 2, a, 1); surface.selection!.set(selected); const before = canonicalJson(e.view);
    expect(surface.selection!.replace("X").status).toBe(mode === "delete-throw" ? "failed" : "not-applicable");
    expect(canonicalJson(e.view)).toBe(before); expect(surface.selection!.get()).toEqual(selected);
    if (mode.startsWith("delete")) expect(calls).toEqual(["text:merge-override", "delete:merge-override", "delete:merge-override"]);
    expect(e.view.roots).toEqual([a, b, last]); e.close();
  }
});

test("boundary Backspace/Delete and beforeinput join at the caret; incompatible empty blocks keep children", async () => {
  for (const trigger of ["Backspace", "Delete", "beforeinput"] as const) {
    const e = editor(), a = add(e, "left"), b = add(e, "right"), surface = await mount(e);
    const backward = trigger !== "Delete", id = backward ? b : a, offset = backward ? 0 : 4;
    surface.selection!.set(range(id, offset, id, offset));
    const text = surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"] [role="textbox"]`)!;
    if (trigger === "beforeinput") text.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
    else expect(key(text, trigger).defaultPrevented).toBe(true);
    await settled(); expect(e.view.roots).toEqual([a]); expect(e.view.blocks[a]!.text!.s).toBe("leftright");
    expect(surface.selection!.get()).toEqual(range(a, 4, a, 4)); e.close();
  }
  const e = editor(), a = add(e, "left"), empty = add(e, ""), child = add(e, "protected", paragraph.type, empty), surface = await mount(e);
  surface.selection!.set(range(empty, 0, empty, 0)); const before = canonicalJson(e.view);
  const text = surface.element.querySelector<HTMLElement>(`[data-nq-block="${empty}"] [role="textbox"]`)!;
  expect(key(text, "Backspace").defaultPrevented).toBe(true); expect(canonicalJson(e.view)).toBe(before);
  expect(liveTree(e.view).alive.has(child)).toBe(true); e.close();
});

test("remote text is mapped before merging and newly incompatible fields cancel the structural operation", async () => {
  const e = editor(), a = add(e, "left"), b = add(e, "right"), peer = editor(), surface = await mount(e);
  Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc)); surface.selection!.set(range(a, 2, b, 2));
  peer.applyTextChanges(b, [{ insert: "++" }]); Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
  expect(surface.selection!.merge("X").status).toBe("applied"); expect(e.view.blocks[a]!.text!.s).toBe("leXght");
  e.close(); peer.close();
  const f = editor(), c = add(f, "first"), d = add(f, "last"), view = await mount(f); view.selection!.set(range(c, 1, d, 1));
  f.setField(d, "new", "keep"); const before = canonicalJson(f.view);
  expect(view.selection!.merge().status).toBe("not-applicable"); expect(canonicalJson(f.view)).toBe(before); f.close();
});

test("command composition uses one frozen snapshot, resolves identities, forbids recursion/escaped contexts, and never commits partial work", () => {
  let saved!: CommandContext;
  const child = defineCommand<null>({ id: "child", label: "Child", validateArgs: (v): v is null => v === null,
    prepare(ctx) { expect(ctx.actor.plugin).toBe("children"); expect(Object.isFrozen(ctx)).toBe(true); return { status: "ready", intent: "child", ops: [{ op: "textEdit", block: ctx.snapshot.roots[0]!, changes: [{ insert: "X" }] }] }; },
  });
  const parent = defineCommand<null>({ id: "parent", label: "Parent", validateArgs: (v): v is null => v === null,
    prepare(ctx) { saved = ctx; expect(ctx.actor.plugin).toBe("parents"); return ctx.prepare(child, null); },
  });
  const recursive = defineCommand<null>({ ...parent, id: "recursive", prepare: ctx => ctx.prepare("recursive", null) });
  const e = new Editor({ docId: "composition", actor: { actorId: "writer" }, plugins: [essentials,
    definePlugin({ id: "parents", version: "1.0.0", apiVersion: 1, contributes: { commands: [parent, recursive] } }),
    definePlugin({ id: "children", version: "1.0.0", apiVersion: 1, contributes: { commands: [child] } }),
  ] });
  const id = add(e, "body"), count = e.view.log.length;
  expect(e.commands.run(parent, null).status).toBe("applied"); expect(e.view.blocks[id]!.text!.s).toBe("Xbody"); expect(e.view.log.length).toBe(count + 1);
  expect(e.view.log.at(-1)!.actor.plugin).toBe("parents"); expect(() => saved.prepare(child, null)).toThrow("expired");
  const before = canonicalJson(e.view); expect(e.commands.run(recursive, null).status).toBe("failed"); expect(canonicalJson(e.view)).toBe(before); e.close();
});

test("secured reader cannot merge even when every selected command prepares successfully", async () => {
  const owner = await createActorKey(), reader = await createActorKey();
  const identity = { actorId: "owner", kind: "human" as const, key: toBase64(owner.publicBytes) }, { docId, nonce } = await createSecuredDocument(identity);
  const e = new Editor({ docId, actor: { actorId: "owner" }, key: owner, plugins: [essentials] });
  await e.initializeAccess({ owner: identity, nonce, grants: [{ actorId: "reader", kind: "human", role: "reader", key: toBase64(reader.publicBytes) }] });
  const a = add(e, "left"), b = add(e, "right"), r = new Editor({ docId, actor: { actorId: "reader" }, key: reader, plugins: [essentials] }); await r.ready;
  Y.applyUpdate(r.ydoc, Y.encodeStateAsUpdate(e.ydoc)); const surface = await mount(r); surface.selection!.set(range(a, 2, b, 2));
  const before = canonicalJson(r.view); expect(surface.selection!.merge("X").status).toBe("denied"); expect(canonicalJson(r.view)).toBe(before);
  expect(surface.selection!.get()).toEqual(range(a, 2, b, 2)); e.close(); r.close();
});


test("empty siblings merge without losing the survivor, and deleting an entire range leaves one editable empty block", async () => {
  for (const text of ["", "body"]) {
    const e = editor(), a = add(e, text), b = add(e, text), surface = await mount(e);
    surface.selection!.set(range(a, 0, b, text.length));
    expect(surface.selection!.replace("").status).toBe("applied"); await settled();
    expect(e.view.roots).toEqual([a]); expect(e.view.blocks[a]!.text!.s).toBe("");
    expect(surface.selection!.get()).toEqual(range(a, 0, a, 0));
    expect(surface.selection!.replace("continue").status).toBe("applied"); expect(e.view.blocks[a]!.text!.s).toBe("continue"); e.close();
  }
});
