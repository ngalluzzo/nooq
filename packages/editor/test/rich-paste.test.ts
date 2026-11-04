import "./dom.ts";
import { expect, test } from "bun:test";
import { canonicalJson, createActorKey, createSecuredDocument, toBase64 } from "@nooq/core";
import { essentials, pasteBlocks } from "@nooq/plugins/essentials";
import { NooqRelay, settled } from "@nooq/sync";
import { decodeHTMLPaste } from "../src/html-paste.ts";
import { Editor, createSurface } from "../src/index.ts";
import { essentialsDOM } from "../src/reference.ts";

const paragraph = "nooq.paragraph/v1";
const word = `<html><body><!--StartFragment-->
<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.<span>&nbsp;&nbsp;</span></span>Plan<o:p>&nbsp;</o:p></p>
<p class="MsoListParagraph" style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;</span></span><b>Check</b></p>
<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2.</span>Ship</p>
<p><o:p>&nbsp;</o:p></p><!--EndFragment--></body></html>`;
const docs = `<b id="docs-internal-guid-demo" style="font-weight:normal"><p dir="ltr"><span style="font-weight:700">Bold</span> <span style="font-style:italic">italic</span></p><p dir="ltr"><br></p><ol><li><span>First</span><ul><li><span>Nested</span></li></ul></li></ol></b>`;

test("Word lists recover nesting and omit supported numbering and Office placeholders", () => {
  const blocks = decodeHTMLPaste(document, word)!;
  expect(blocks.map(block => [block.type, block.fields?.kind, block.text?.s])).toEqual([
    ["nooq.list/v1", "number", "Plan"], ["nooq.list/v1", "number", "Ship"],
  ]);
  const nested = blocks[0]!.children[0]!;
  expect(nested.fields?.kind).toBe("bullet");
  expect(nested.text).toEqual({ s: "Check", marks: Array.from({ length: 5 }, () => ["strong"]) });
  const unsupported = decodeHTMLPaste(document, '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">iv.</span> Option</p>')!;
  expect(unsupported[0]!.text?.s).toBe("iv. Option");
});

test("Google Docs preserves styled runs, intentional blank paragraphs, and semantic lists", () => {
  const [first, blank, list] = decodeHTMLPaste(document, docs)!;
  expect(first!.text?.s).toBe("Bold italic");
  expect(first!.text?.marks[0]).toEqual(["strong"]);
  expect(first!.text?.marks[4]).toEqual([]);
  expect(first!.text?.marks[5]).toEqual(["em"]);
  expect(blank!.text?.s).toBe("");
  expect(list!.fields?.kind).toBe("number");
  expect(list!.children[0]!.text?.s).toBe("Nested");
});

test("web paste keeps nested inline marks and safe link payloads", () => {
  const blocks = decodeHTMLPaste(document, `<article style="font-weight:bold"><h2>Intro</h2><p>See <em><a href="https://example.org/">this</a></em><script>hidden</script><a style="font-weight:normal" href="javascript:bad()"> page</a><img src="https://example.org/beacon" alt=" diagram"></p></article>`)!;
  expect(blocks[0]!.type).toBe("nooq.heading/v1");
  expect(blocks[0]!.fields?.level).toBe(2);
  const block = blocks[1]!;
  const key = Object.keys(block.fields!)[0]!;
  expect(block.fields).toEqual({ [key]: "https://example.org/" });
  expect(block.text?.s).toBe("See this page diagram");
  expect(block.text?.marks[4]).toEqual(["em", key, "strong"]);
  expect(block.text?.marks[9]).toEqual([]);
});

test("surface paste chooses HTML once, splices the selection, and keeps Markdown paste single", async () => {
  const editor = new Editor({ docId: "clipboard-owner", actor: { actorId: "human:writer" }, plugins: [essentials] });
  const block = editor.insertBlock({ type: paragraph, parent: null, text: "Keep old end" });
  const surface = createSurface(editor, { plugins: [essentialsDOM] });
  document.body.append(surface.element);
  try {
    await settled();
    const input = surface.element.querySelector("textarea")!;
    input.focus();
    input.setSelectionRange(5, 8);
    const fire = (plain: string, html?: string) => {
      const data = new DataTransfer();
      data.setData("text/plain", plain);
      if (html !== undefined) data.setData("text/html", html);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    let count = editor.history().length;
    fire("# ignored plain flavor", "<strong>new</strong>");
    expect(editor.history()).toHaveLength(count + 1);
    await settled();
    expect(editor.view.blocks[block]!.text?.s).toBe("Keep new end");
    expect(editor.view.blocks[block]!.text?.marks[5]).toEqual(["strong"]);
    expect(input.selectionStart).toBe(8);

    count = editor.history().length;
    fire("# Markdown heading");
    expect(editor.history()).toHaveLength(count + 1);
    expect(editor.view.blocks[block]!.text?.s).toBe("Keep new end");
    expect(editor.view.blocks[editor.view.roots[1]!]!.text?.s).toBe("Markdown heading");

    await settled();
    input.focus();
    input.setSelectionRange(5, 8);
    count = editor.history().length;
    fire("", "<p><img src='https://example.org/unavailable'></p>");
    expect(editor.history()).toHaveLength(count);
    fire("fallback", "<p><script>ignored</script></p>");
    expect(editor.history()).toHaveLength(count + 1);
    expect(editor.view.blocks[block]!.text?.s).toBe("Keep fallback end");
  } finally {
    surface.destroy();
    surface.element.remove();
    editor.close();
  }
});

test("structural paste preserves the two sides and places the caret before the trailing text", () => {
  const editor = new Editor({ docId: "structural-paste", actor: { actorId: "human:writer" }, plugins: [essentials] });
  try {
    const id = editor.insertBlock({ type: paragraph, parent: null, text: "A old Z" });
    const blocks = decodeHTMLPaste(document, "<p>first</p><h2>title</h2><p>last</p>")!;
    const count = editor.history().length;
    const result = editor.commands.run(pasteBlocks, { range: { anchor: { block: id, offset: 2 }, head: { block: id, offset: 5 } }, blocks });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(editor.history()).toHaveLength(count + 1);
    expect(editor.view.roots.map(id => editor.view.blocks[id]!.text?.s)).toEqual(["A first", "title", "last Z"]);
    expect(result.selection).toEqual({ block: editor.view.roots[2]!, anchor: 4, head: 4 });
    editor.undo();
    expect(editor.view.roots).toEqual([id]);
    expect(editor.view.blocks[id]!.text?.s).toBe("A old Z");
    editor.redo();
    expect(editor.view.roots.map(id => editor.view.blocks[id]!.text?.s)).toEqual(["A first", "title", "last Z"]);
  } finally { editor.close(); }
});

test("HTML paste from a backward document selection is one edit and focuses the new caret", async () => {
  const editor = new Editor({ docId: "document-rich-paste", actor: { actorId: "human:writer" }, plugins: [essentials] });
  const first = editor.insertBlock({ type: paragraph, parent: null, text: "Keep old" });
  const second = editor.insertBlock({ type: paragraph, parent: null, text: "also old end" });
  const surface = createSurface(editor, { plugins: [essentialsDOM], textMode: "rich", selectionMode: "document" });
  document.body.append(surface.element);
  try {
    await settled();
    expect(surface.selection!.set({ anchor: { block: second, offset: 8 }, head: { block: first, offset: 5 } })).toBe(true);
    const data = new DataTransfer();
    data.setData("text/html", "<strong>new</strong>");
    data.setData("text/plain", "ignored plain flavor");
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    const before = editor.history().length;
    surface.element.dispatchEvent(event);
    await settled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.history()).toHaveLength(before + 1);
    expect(editor.view.roots).toEqual([first]);
    expect(editor.view.blocks[first]!.text?.s).toBe("Keep new end");
    expect(editor.view.blocks[first]!.text?.marks[5]).toEqual(["strong"]);
    const caret = { block: first, offset: 8 };
    expect(surface.selection!.get()).toEqual({ anchor: caret, head: caret });
  } finally {
    surface.destroy();
    surface.element.remove();
    editor.close();
  }
});

test("one rich paste undoes original formatting after a peer types before and inside the pasted text", async () => {
  const relay = new NooqRelay();
  const [aliceKey, bobKey] = await Promise.all([createActorKey(), createActorKey()]);
  const owner = { actorId: "human:alice", key: toBase64(aliceKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(owner);
  const alice = new Editor({ docId, actor: { actorId: owner.actorId }, key: aliceKey, plugins: [essentials], transport: relay.connect(docId) });
  const bob = new Editor({ docId, actor: { actorId: "human:bob" }, key: bobKey, plugins: [essentials], transport: relay.connect(docId) });
  try {
    await alice.initializeAccess({ owner, nonce, grants: [{ actorId: "human:bob", key: toBase64(bobKey.publicBytes), kind: "human", role: "writer" }] });
    await settled();
    const id = alice.insertBlock({ type: paragraph, parent: null, text: "abOLDef" });
    alice.commands.run("nooq.text.edit", { block: id, changes: [{ retain: 2 }, { retain: 3, setMarks: ["strong"] }] });
    alice.flush();
    await settled();
    const blocks = decodeHTMLPaste(document, "<i>NEW</i>")!;
    const before = alice.history().length;
    const envelopes = relay.envelopesOf(docId).length;
    expect(alice.commands.run(pasteBlocks, { blocks, range: { anchor: { block: id, offset: 2 }, head: { block: id, offset: 5 } } }).status).toBe("applied");
    expect(alice.history()).toHaveLength(before + 1);
    await settled();
    expect(relay.envelopesOf(docId)).toHaveLength(envelopes + 1);
    bob.commands.run("nooq.text.edit", { block: id, changes: [{ insert: "!" }, { retain: 3 }, { insert: "?" }] });
    bob.flush();
    await settled();
    expect(alice.view.blocks[id]!.text?.s).toBe("!abN?EWef");
    alice.undo();
    await settled();
    expect(alice.view.blocks[id]!.text?.s).toBe("!abOLD?ef");
    expect(alice.view.blocks[id]!.text?.marks.slice(3, 6)).toEqual([["strong"], ["strong"], ["strong"]]);
    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
    alice.redo();
    await settled();
    expect(alice.view.blocks[id]!.text?.s).toBe("!abN?EWef");
    expect(alice.view.blocks[id]!.text?.marks[3]).toEqual(["em"]);
    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
  } finally {
    alice.close();
    bob.close();
  }
});

test("undo restores a replaced block in order after a peer inserts siblings on both sides", async () => {
  const relay = new NooqRelay(), docId = "structural-paste-peers";
  const peer = (actorId: string) => new Editor({ docId, actor: { actorId }, plugins: [essentials], transport: relay.connect(docId) });
  const alice = peer("human:alice"), bob = peer("human:bob");
  try {
    await settled();
    const left = alice.insertBlock({ type: paragraph, parent: null, text: "Before" });
    const id = alice.insertBlock({ type: paragraph, parent: null, text: "Old" });
    const right = alice.insertBlock({ type: paragraph, parent: null, text: "After" });
    alice.commands.run("nooq.text.edit", { block: id, changes: [{ retain: 3, setMarks: ["strong"] }] });
    const blocks = decodeHTMLPaste(document, word)!;
    expect(alice.commands.run(pasteBlocks, { blocks, range: { anchor: { block: id, offset: 0 }, head: { block: id, offset: 3 } } }).status).toBe("applied");
    const pasted = alice.view.roots.slice(1, -1);
    const nested = alice.view.blocks[pasted[0]!]!.children[0]!;
    await settled();
    const before = bob.insertBlock({ type: paragraph, parent: null, index: 1, text: "Peer before" });
    const after = bob.insertBlock({ type: paragraph, parent: null, index: bob.view.roots.length - 1, text: "Peer after" });
    await settled();
    alice.undo();
    await settled();
    expect(alice.view.roots).toEqual([left, before, id, after, right]);
    expect(alice.view.blocks[id]!.text?.marks[0]).toEqual(["strong"]);
    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
    alice.redo();
    await settled();
    expect(alice.view.roots).toEqual([left, before, ...pasted, after, right]);
    expect(alice.view.blocks[pasted[0]!]!.children).toEqual([nested]);
    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
  } finally {
    alice.close();
    bob.close();
  }
});
