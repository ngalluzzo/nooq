import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, createActorKey, createSecuredDocument, toBase64 } from "@nooq/core";
import { defineCommand, definePlugin, resolveTextRange, type DocumentTextSelection, type Plugin } from "@nooq/plugins";
import { defineDOMPlugin, defineTextPolicy } from "@nooq/plugins/dom";
import { essentials, editText, insertBlock, paragraph } from "@nooq/plugins/essentials";
import { callout, callouts } from "@nooq/plugin-callouts";
import { calloutsDOM, calloutsPlainDOM } from "@nooq/plugin-callouts/dom";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

const point = (block: string, offset: number) => ({ block, offset });
const range = (a: string, x: number, h: string, y: number): DocumentTextSelection => ({ anchor: point(a, x), head: point(h, y) });
function insert(e: Editor, type: string, text: string, parent: string | null = null) {
  const result = e.commands.run(insertBlock, { type, parent }); if (result.status !== "applied") throw new Error(result.status);
  e.editText(result.selection!.block, text); return result.selection!.block;
}
async function fixture(override?: Plugin, restricted = false, legacy = false) {
  const e = new Editor({ docId: "document-selection", actor: { actorId: "writer" }, plugins: [essentials, callouts, ...(override ? [override] : [])],
    ...(override ? { resolve: { "command:nooq.text.edit": override.id } } : {}),
  });
  const a = insert(e, paragraph.type, "A😀B"), b = insert(e, callout.type, "callout"), child = insert(e, paragraph.type, "nested", b);
  const c = e.insertBlock({ type: "unknown/v9", parent: null, text: "opaque" }); e.setField(c, "keep", { secret: "retained" });
  e.applyTextChanges(a, [{ retain: 1 }, { retain: 2, setMarks: ["future", "strong"] }]);
  const dom = legacy ? calloutsPlainDOM : restricted ? defineDOMPlugin({ ...calloutsDOM, views: calloutsDOM.views.map(v => ({ ...v, textPolicy: defineTextPolicy({ marks: ["em"] }) })) }) : calloutsDOM;
  const s = createSurface(e, { plugins: [essentialsDOM, dom], textMode: "rich", selectionMode: "document" });
  document.body.append(s.element); await settled(); return { e, s, selection: s.selection!, a, b, child, c };
}
const key = (element: HTMLElement, value: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }); element.dispatchEvent(event); return event;
};
const override = (prepare: typeof editText.prepare) => definePlugin({ id: "override", version: "1.0.0", apiVersion: 1, contributes: { commands: [defineCommand({ ...editText, prepare })] } });

test("directional UTF-16 ranges include nested and unknown text, excluding all chrome", async () => {
  const { e, selection, a, b, child, c } = await fixture();
  const backwards = range(c, 2, a, 1), before = canonicalJson(e.view);
  expect(selection.set(backwards)).toBe(true); expect(selection.get()).toEqual(backwards);
  expect(selection.text()).toBe("😀B\ncallout\nnested\nop");
  expect(resolveTextRange(e.view, backwards)).toEqual([{ block: a, from: 1, to: 4 }, { block: b, from: 0, to: 7 }, { block: child, from: 0, to: 6 }, { block: c, from: 0, to: 2 }]);
  const returned = selection.get()!; (returned.anchor as { offset: number }).offset = 0; expect(selection.get()).toEqual(backwards);
  expect(selection.set(range(c, -1, a, 0))).toBe(false); expect(selection.set(range("missing", 0, a, 0))).toBe(false);
  expect(canonicalJson(e.view)).toBe(before); e.close();
});

test("range replacement is one selected-command transaction and preserves every block and child", async () => {
  const { e, selection, a, b, child, c } = await fixture();
  const peer = new Editor({ docId: "document-selection", actor: { actorId: "peer" } }); Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
  const roots = [...e.view.roots], fields = structuredClone(e.view.blocks[b]!.fields), before = e.view.log.length;
  selection.set(range(c, 2, a, 3)); expect(selection.replace("X").status).toBe("applied"); await settled();
  expect(e.view.blocks[a]!.text).toEqual({ s: "A😀X", marks: [[], ["future", "strong"], ["future", "strong"], []] });
  expect(e.view.blocks[b]!.text!.s).toBe(""); expect(e.view.blocks[child]!.text!.s).toBe(""); expect(e.view.blocks[c]!.text!.s).toBe("aque");
  expect(e.view.roots).toEqual(roots); expect(e.view.blocks[b]!.children).toEqual([child]); expect(e.view.blocks[b]!.fields).toEqual(fields);
  expect(e.view.blocks[c]!.fields.keep).toEqual({ secret: "retained" }); expect(e.view.log).toHaveLength(before + 1);
  expect(e.view.log.at(-1)!.actor.plugin).toBe(essentials.id); expect(selection.get()).toEqual(range(a, 4, a, 4));
  Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc)); expect(canonicalJson(peer.view)).toBe(canonicalJson(e.view)); e.close(); peer.close();
});

test("formatting preserves opaque marks and declines all when a participating policy disallows it", async () => {
  const f = await fixture(); f.selection.set(range(f.a, 1, f.b, 2)); expect(f.selection.toggleMark("em").status).toBe("applied"); await settled();
  expect(f.e.view.blocks[f.a]!.text!.marks[1]).toEqual(["em", "future", "strong"]); expect(f.e.view.blocks[f.b]!.text!.marks[0]).toEqual(["em"]);
  expect(f.selection.get()).toEqual(range(f.a, 1, f.b, 2)); expect(f.selection.toggleMark("em").status).toBe("applied");
  expect(f.e.view.blocks[f.a]!.text!.marks[1]).toEqual(["future", "strong"]); f.e.close();
  const g = await fixture(undefined, true); g.selection.set(range(g.a, 0, g.b, 1)); const before = canonicalJson(g.e.view);
  expect(g.selection.toggleMark("strong").status).toBe("not-applicable"); expect(canonicalJson(g.e.view)).toBe(before); g.e.close();
});

test("a selected text-command override can decline a later item without partial edits or losing the range", async () => {
  const feature = override((ctx, args) => ctx.snapshot.blocks[args.block]!.type === callout.type ? { status: "not-applicable" } : editText.prepare(ctx, args));
  const { e, s, selection, a, b } = await fixture(feature); const selected = range(b, 3, a, 1); selection.set(selected); const before = canonicalJson(e.view);
  expect(selection.replace("replacement").status).toBe("not-applicable"); expect(canonicalJson(e.view)).toBe(before); expect(selection.get()).toEqual(selected);
  expect(key(s.element, "Backspace").defaultPrevented).toBe(true); expect(canonicalJson(e.view)).toBe(before); e.close();
});

test("batch validation, exceptions, and missing commands leave no partial writes", async () => {
  const { e, a, b } = await fixture(); const before = canonicalJson(e.view);
  expect(e.commands.batch(editText, [{ block: a, changes: [{ insert: "X" }] }, { block: b, changes: [{ delete: 999 }] }]).status).toBe("failed");
  expect(e.commands.batch(editText, [{ block: a, changes: [{ insert: "X" }] }, { block: "missing", changes: [] }]).status).toBe("not-applicable");
  expect(e.commands.batch("missing", [null]).status).toBe("failed"); expect(e.commands.batch(editText, []).status).toBe("not-applicable");
  expect(canonicalJson(e.view)).toBe(before); e.close(); expect(e.commands.batch(editText, []).status).toBe("failed");
});

test("remote text maps both endpoints before render; outside insertions keep the selected span", async () => {
  const { e, selection, a, b, c } = await fixture(); selection.set(range(b, 3, a, 1));
  const peer = new Editor({ docId: "document-selection", actor: { actorId: "peer" } }); Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
  peer.applyTextChanges(a, [{ insert: "++" }]); peer.applyTextChanges(b, [{ insert: "_" }]); peer.insertBlock({ type: "unknown", parent: null, text: "outside" });
  Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
  expect(selection.get()).toEqual(range(b, 4, a, 3)); expect(selection.text()).toBe("😀B\n_cal");
  await settled(); expect(selection.get()).toEqual(range(b, 4, a, 3));
  selection.replace("Z"); expect(e.view.blocks[a]!.text!.s).toBe("++AZ"); expect(e.view.blocks[b]!.text!.s).toBe("lout");
  expect(e.view.blocks[c]!.text!.s).toBe("opaque"); e.close(); peer.close();
});

test("span membership changes cancel selection before a stale replacement can run", async () => {
  for (const change of ["delete", "insert", "move"] as const) {
    const { e, selection, a, b, c } = await fixture(); selection.set(range(a, 1, c, 2));
    if (change === "delete") e.deleteBlock(b);
    else if (change === "insert") e.insertBlock({ type: "unknown", parent: null, text: "new", index: 1 });
    else e.moveBlock(c, null, 0);
    const before = canonicalJson(e.view); expect(selection.replace("stale").status).toBe("not-applicable"); expect(selection.get()).toBeUndefined();
    expect(canonicalJson(e.view)).toBe(before); e.close();
  }
});

test("keyboard extends across block boundaries, selects all text, and replaces atomically", async () => {
  const { e, s, selection, a, b, c } = await fixture(); selection.set(range(a, 4, a, 4));
  const first = s.element.querySelector<HTMLElement>('[aria-label="Text"]')!;
  expect(key(first, "ArrowRight", { shiftKey: true }).defaultPrevented).toBe(true); expect(selection.get()).toEqual(range(a, 4, b, 0));
  key(s.element, "ArrowRight", { shiftKey: true }); expect(selection.get()).toEqual(range(a, 4, b, 1));
  key(s.element, "a", { ctrlKey: true }); expect(selection.get()).toEqual(range(a, 0, c, 6));
  const before = e.view.log.length; key(s.element, "Q"); await settled(); expect(e.view.log).toHaveLength(before + 1); expect(e.view.blocks[a]!.text!.s).toBe("Q"); e.close();
});

test("clipboard copies document text only, and paste/cut share the selected command boundary", async () => {
  const { e, s, selection, a, b } = await fixture(); selection.set(range(a, 1, b, 3));
  const data = new DataTransfer(), copied = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
  s.element.dispatchEvent(copied); expect(copied.defaultPrevented).toBe(true); expect(data.getData("text/plain")).toBe("😀B\ncal"); expect(data.getData("text/html")).toBe("");
  const paste = new DataTransfer(); paste.setData("text/plain", "p\r\nq"); paste.setData("text/html", "<script>bad()</script>");
  s.element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true })); await settled();
  expect(e.view.blocks[a]!.text!.s).toBe("Ap\nq"); expect(e.view.blocks[b]!.text!.s).toBe("lout");
  selection.set(range(a, 1, b, 1)); s.element.dispatchEvent(new ClipboardEvent("cut", { clipboardData: data, bubbles: true, cancelable: true }));
  expect(data.getData("text/plain")).toBe("p\nq\nl"); expect(e.view.blocks[a]!.text!.s).toBe("A"); expect(e.view.blocks[b]!.text!.s).toBe("out"); e.close();
});

test("legacy textarea barriers, other surfaces, and disposal cannot authorize a document range", async () => {
  const { e, s, selection, a, c } = await fixture(undefined, false, true);
  expect(selection.set(range(a, 0, c, 1))).toBe(false); expect(selection.replace("no").status).toBe("not-applicable");
  const second = await fixture(); expect(second.selection.set(range(a, 0, second.c, 1))).toBe(false);
  s.destroy(); const before = canonicalJson(e.view); expect(selection.set(range(a, 0, c, 1))).toBe(false); expect(selection.get()).toBeUndefined();
  expect(selection.replace("no").status).toBe("not-applicable"); expect(canonicalJson(e.view)).toBe(before); e.close(); second.e.close();
});

test("secured reader authorization denies the entire multi-block edit", async () => {
  const owner = await createActorKey(), reader = await createActorKey();
  const party = { actorId: "owner", kind: "human" as const, key: toBase64(owner.publicBytes) }, { docId, nonce } = await createSecuredDocument(party);
  const a = new Editor({ docId, actor: { actorId: "owner" }, key: owner, plugins: [essentials] });
  await a.initializeAccess({ owner: party, nonce, grants: [{ actorId: "reader", kind: "human", role: "reader", key: toBase64(reader.publicBytes) }] });
  const first = insert(a, paragraph.type, "first"), last = insert(a, paragraph.type, "last");
  const b = new Editor({ docId, actor: { actorId: "reader" }, key: reader, plugins: [essentials] }); await b.ready; Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  const s = createSurface(b, { plugins: [essentialsDOM], textMode: "rich", selectionMode: "document" }); document.body.append(s.element); await settled();
  s.selection!.set(range(first, 2, last, 2)); const before = canonicalJson(b.view); expect(s.selection!.replace("denied").status).toBe("denied");
  expect(canonicalJson(b.view)).toBe(before); expect(s.selection!.get()).toEqual(range(first, 2, last, 2)); a.close(); b.close();
});

test("batch preparation is synchronous, isolated, and cannot reenter the runtime", async () => {
  let editor!: Editor;
  const command = defineCommand<number>({ id: "batch-probe", label: "Batch probe", validateArgs: (v): v is number => Number.isInteger(v),
    prepare(ctx, n) {
      expect(Object.isFrozen(ctx)).toBe(true); expect(Object.isFrozen(ctx.snapshot)).toBe(true);
      expect(editor.commands.batch("batch-probe", [0]).status).toBe("failed");
      if (n === 2) throw new Error("second item failed");
      return { status: "ready", intent: "probe", ops: [{ op: "textEdit", block: ctx.snapshot.roots[0]!, changes: [{ insert: "X" }] }] };
    },
  });
  const plugin = definePlugin({ id: "probe", version: "1.0.0", apiVersion: 1, contributes: { commands: [command] } });
  editor = new Editor({ docId: "batch", actor: { actorId: "writer" }, plugins: [essentials, plugin] }); insert(editor, paragraph.type, "original");
  const before = canonicalJson(editor.view); expect(editor.commands.batch(command, [1, 2]).status).toBe("failed");
  expect(canonicalJson(editor.view)).toBe(before); expect(editor.commands.batch(command, [1, "bad"] as number[]).status).toBe("failed"); expect(canonicalJson(editor.view)).toBe(before); editor.close();
});

test("a range cannot retain editing authority after focus leaves its surface", async () => {
  const { e, selection, a, b } = await fixture(); selection.set(range(a, 1, b, 3));
  const other = document.createElement("input"); document.body.append(other); other.focus();
  const before = canonicalJson(e.view); expect(selection.get()).toBeUndefined(); expect(selection.replace("stale").status).toBe("not-applicable"); expect(canonicalJson(e.view)).toBe(before);
  other.remove(); e.close();
});

test("range edits honor the selected command's explicit post-edit selection", async () => {
  const feature = override((ctx, args) => {
    const prepared = editText.prepare(ctx, args);
    return prepared.status === "ready" ? { ...prepared, selection: { block: args.block, anchor: 0, head: 0 } } : prepared;
  });
  const { e, selection, a, b } = await fixture(feature); selection.set(range(a, 2, b, 3));
  expect(selection.replace("X").status).toBe("applied"); expect(selection.get()).toEqual(range(b, 0, b, 0));
  await settled(); expect(selection.get()).toEqual(range(b, 0, b, 0)); e.close();
});
