/** Links and payloaded marks (0009): per-surface rendering, drift detection, foreign-host relay, and the Mod-k flow. */
import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, type JsonValue, type RenderedText } from "@nooq/core";
import { defineBlock, definePlugin } from "@nooq/plugins";
import { defineDOMPlugin, type MarkRenderer, type RichTextBinding } from "@nooq/plugins/dom";
import { essentials, link, paragraph } from "@nooq/plugins/essentials";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { baseOf } from "../src/mark-tokens.ts";
import { mountRichText } from "../src/rich-text.ts";
import { referenceDOM, referenceJobBindings, referencePlugins, writingTextPolicy } from "../src/reference.ts";

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

/** The one link token stored on a block, when the writer linked exactly one span. */
function linkTokenOf(editor: Editor, block: string): string | undefined {
  const marks = editor.view.blocks[block]?.text?.marks ?? [];
  for (const names of marks) { const token = names.find(name => baseOf(name) === "link"); if (token) return token; }
  return undefined;
}

test("payloaded marks render through the policy's renderer, re-render on payload edits, and degrade to a resolved §8", () => {
  const seen: { payload: unknown; text: string }[] = [];
  const renderer: MarkRenderer = (payload, text) => {
    seen.push({ payload, text });
    const anchor = document.createElement("a");
    anchor.className = "nq-test-link";
    if (typeof payload === "string") anchor.setAttribute("href", payload);
    anchor.textContent = text;
    return anchor;
  };
  let current: RenderedText = { s: "", marks: [] };
  let fields: Record<string, JsonValue> = {};
  const binding = mountRichText({ read: () => current, fields: () => fields, commit: () => true, keyDown: () => false, input: () => {} }, { renderMarks: { link: renderer } });
  document.body.append(binding.element);

  const text = (token: string | undefined): RenderedText => ({
    s: "nooq writes",
    marks: Array.from({ length: 11 }, (_, at) => at >= 5 && at < 11 ? [token!] : []),
  });
  // A token without its payload is a partial state: §8, visible and preserved.
  binding.update({ s: "orphan", marks: Array.from({ length: 6 }, () => ["link:gone"]) }, {});
  const partial = binding.element.querySelector<HTMLElement>("[data-nq-marks]")!;
  expect(JSON.parse(partial.getAttribute("data-nq-marks")!)).toEqual(["link:gone"]);
  expect(partial.textContent).toBe("orphan");

  // The token over "writes" with its payload in fields: the renderer's anchor carries both halves.
  current = text("link:t1"); fields = { "link:t1": "https://nooq.dev" };
  binding.update(current, fields);
  const anchor = binding.element.querySelector<HTMLElement>("a[data-nq-token='link:t1']")!;
  expect(anchor.getAttribute("href")).toBe("https://nooq.dev");
  expect(anchor.textContent).toBe("writes"); // PM places the covered text inside the renderer's element
  expect(seen.at(-1)).toEqual({ payload: "https://nooq.dev", text: "" }); // the covered text arrives via PM, not the renderer

  // Only the payload changed — text and marks byte-identical — and the span still re-renders (0009 §1).
  fields = { "link:t1": "https://example.com" };
  binding.update(current, fields);
  expect(binding.element.querySelector<HTMLElement>("a[data-nq-token='link:t1']")!.getAttribute("href")).toBe("https://example.com");

  // §8's courtesy: an unknown token names its meaning when a sibling fields entry exists.
  binding.update({ s: "odd", marks: Array.from({ length: 3 }, () => ["weird:x"]) }, { "weird:x": "hi" });
  const unknown = binding.element.querySelector<HTMLElement>("[data-nq-marks]")!;
  expect(unknown.title).toBe("Unrecognized formatting: Weird: hi");

  // The authoring set matches by base: a payloaded base never toggles (0009 §2).
  expect(binding.toggleMark("link" as never)).toBe(false);
  binding.destroy();
});

const relayBlock = defineBlock({ type: "test.relay/v1", label: "Relay", text: "inline", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
const relayPlugin = definePlugin({ id: "test.relay", version: "1.0.0", apiVersion: 1, contributes: { blocks: [relayBlock] } });

test("a foreign host relays tokens and payloads byte-identically, showing §8 with the resolved title", async () => {
  let foreign: RichTextBinding | undefined;
  // A rich host with NO link renderer — the universal §8 fallback, never data loss.
  const relayDOM = defineDOMPlugin({ id: relayPlugin.id, forPlugin: relayPlugin, views: [{ type: relayBlock.type, mount(ctx) {
    foreign = ctx.mountRichText();
    const element = document.createElement("div"); element.append(foreign.element, ctx.children.element);
    return { element, update() {} };
  } }] });
  const a = new Editor({ docId: "links-relay", actor: { actorId: "writer" }, plugins: [relayPlugin, essentials] });
  const id = a.insertBlock({ type: relayBlock.type, parent: null, text: "nooq writes in ink." });
  expect(a.commands.run(link, { block: id, from: 5, to: 11, href: "https://nooq.dev" }).status).toBe("applied");
  const token = linkTokenOf(a, id)!;
  expect(token.startsWith("link:")).toBe(true);

  const surface = createSurface(a, { plugins: [relayDOM] }); document.body.append(surface.element); await settled();
  const unknown = foreign!.element.querySelector<HTMLElement>("[data-nq-marks]")!;
  expect(JSON.parse(unknown.getAttribute("data-nq-marks")!)).toEqual([token]);
  expect(unknown.title).toBe("Unrecognized formatting: Link: https://nooq.dev"); // the §8 courtesy names the meaning
  expect(unknown.textContent).toBe("writes");

  // The relay peer: no plugins at all, edits around the link, syncs back.
  const b = new Editor({ docId: "links-relay", actor: { actorId: "relay" } });
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  b.applyTextChanges(id, [{ insert: "--" }]);
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc)); await settled();
  expect(canonicalJson(a.view)).toBe(canonicalJson(b.view)); // the relay lost nothing
  const relayed = b.view.blocks[id]!;
  for (const names of relayed.text!.marks.slice(7, 13)) expect(names).toContain(token); // "--nooq writes…": the span moved with the text
  expect(relayed.fields[token]).toBe("https://nooq.dev");
  expect(unknown.isConnected).toBe(true); // the foreign host kept rendering through the sync

  surface.destroy(); a.close(); b.close();
});

test("editing a link's href drifts a proposal made through the review flow over the linked text", async () => {
  const editor = new Editor({ docId: "links-drift", actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const id = editor.insertBlock({ type: paragraph.type, parent: null, text: "nooq writes in ink." });
  expect(editor.commands.run(link, { block: id, from: 0, to: 4, href: "https://nooq.dev" }).status).toBe("applied");

  // A real proposal over the linked text: the reference rewrite job publishes through the review flow.
  const handle = editor.jobs.start("nooq.ai.rewrite", { block: id });
  const publication = (await handle.result) as { status: string; suggestion: string };
  expect(publication.status).toBe("published");
  await settled();
  const suggestion = publication.suggestion;
  expect((await editor.reviewSuggestion(suggestion)).evaluation.status).toBe("fresh");

  // Same text, same marks — only the payload changed. The content digest carries fields, so the evidence drifts.
  editor.setField(id, linkTokenOf(editor, id)!, "https://example.com");
  const evaluation = (await editor.reviewSuggestion(suggestion)).evaluation;
  expect(evaluation.status).toBe("stale");
  expect(evaluation.drift).toEqual([{ block: id, reason: "content" }]);
  editor.close();
});

const key = (element: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event); return event;
};
/** A native selection over character offsets, as a writer's drag would leave it. */
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

test("Mod-k opens the popover on the selection; Enter applies one atomic transaction; Esc returns focus with no change", async () => {
  expect(writingTextPolicy.marks).toContain("link"); // the reference policy admits the reserved base (0009 §5)
  const editor = new Editor({ docId: "links-modk", actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  document.body.append(surface.element);
  const id = editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  await settled();
  const host = surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"] .nq-rich-text`)!;

  // The surface's mount focus is a collapsed caret: Mod-k has nothing to link and opens nothing.
  expect(document.body.querySelector(".nq-popover")).toBeNull();
  key(host, "k", { metaKey: true });
  expect(document.body.querySelector(".nq-popover")).toBeNull();

  // Mod-k over "writes" opens one popover, empty (nothing linked yet), focus in the field.
  selectChars(host, 5, 11);
  const before = editor.history().length;
  expect(key(host, "k", { metaKey: true }).defaultPrevented).toBe(true);
  const input = document.body.querySelector<HTMLInputElement>(".nq-popover input")!;
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);

  // Enter applies nooq.text.link: exactly ONE transaction, carrying both halves (0009 §1).
  input.value = "https://nooq.dev";
  key(input, "Enter"); await settled();
  expect(editor.history()).toHaveLength(before + 1);
  const tx = editor.history().at(-1)!;
  expect(tx.intent).toBe("add-link");
  const setField = tx.ops.find(op => op.op === "setField")!;
  expect(setField.op).toBe("setField");
  expect((setField as { key: string }).key.startsWith("link:")).toBe(true);
  expect((setField as { value: unknown }).value).toBe("https://nooq.dev");
  expect(tx.ops.some(op => op.op === "textEdit" && op.block === id)).toBe(true);
  const token = (setField as { key: string }).key;
  const marks = editor.view.blocks[id]!.text!.marks;
  expect(marks.slice(5, 11).every(names => names.includes(token))).toBe(true);
  expect(marks.slice(0, 5).every(names => !names.includes(token))).toBe(true);
  expect(editor.view.blocks[id]!.fields[token]).toBe("https://nooq.dev");

  // The rendered anchor: the policy renderer's element, carrying the href, styled by class (§5).
  const anchor = host.querySelector<HTMLElement>("a.nq-link")!;
  expect(anchor.getAttribute("href")).toBe("https://nooq.dev");
  expect(anchor.getAttribute("data-nq-token")).toBe(token);
  expect(anchor.textContent).toBe("writes");
  expect(document.body.querySelector(".nq-popover")).toBeNull(); // applied closes the popover
  expect(document.activeElement).toBe(host);                     // and returns focus to the selection

  // Esc no-ops with focus returned: prefilled from marks + fields, dismissed unchanged.
  selectChars(host, 5, 11);
  key(host, "k", { metaKey: true });
  const prefilled = document.body.querySelector<HTMLInputElement>(".nq-popover input")!;
  expect(prefilled.value).toBe("https://nooq.dev");
  key(prefilled, "Escape"); await flush();
  expect(document.body.querySelector(".nq-popover")).toBeNull();
  expect(document.activeElement).toBe(host);
  expect(editor.history()).toHaveLength(before + 1); // no change
  expect(host.querySelector("a.nq-link")!.getAttribute("href")).toBe("https://nooq.dev");

  // Editing only the href through the model re-renders the span: same text, same marks, new payload.
  editor.setField(id, token, "https://example.com"); await settled();
  expect(host.querySelector<HTMLElement>("a.nq-link")!.getAttribute("href")).toBe("https://example.com");
  expect(editor.view.blocks[id]!.text!.s).toBe("Maya writes in ink.");

  // An emptied href on an already-linked selection removes the link; the field orphans (GC non-goal).
  const beforeRemove = editor.history().length;
  selectChars(host, 5, 11);
  key(host, "k", { metaKey: true });
  const emptied = document.body.querySelector<HTMLInputElement>(".nq-popover input")!;
  emptied.value = "";
  key(emptied, "Enter"); await settled();
  expect(editor.history()).toHaveLength(beforeRemove + 1);
  expect(editor.history().at(-1)!.intent).toBe("remove-link");
  expect(editor.view.blocks[id]!.text!.marks.every(names => !names.some(name => baseOf(name) === "link"))).toBe(true);
  expect(editor.view.blocks[id]!.fields[token]).toBe("https://example.com"); // the payload orphans at its last value (DM-3.4)
  expect(host.querySelector("a.nq-link")).toBeNull();

  surface.destroy(); editor.close();
});
