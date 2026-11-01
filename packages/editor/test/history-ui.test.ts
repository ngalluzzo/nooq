/** Block history on the surface (0005): the filter behind the popover, the interactive bar, and the deleted flow. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { liveTree } from "@nooq/core";
import { PEER_INKS } from "@nooq/design";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { blockHistoryRows, laterEditsOf, opTouchesBlock, restoreParentOf, transactionsTouching } from "../src/history-ui.ts";
import { referenceDOM, referencePlugins, referenceJobBindings } from "../src/reference.ts";
import { settled } from "@nooq/sync";

function editorWith(): { editor: Editor; surface: ReturnType<typeof createSurface> } {
  const editor = new Editor({ plugins: referencePlugins, jobBindings: referenceJobBindings(), docId: "history-ui-test", actor: { actorId: "human:writer", name: "Writer" } });
  const surface = createSurface(editor, { plugins: referenceDOM });
  document.body.append(surface.element);
  return { editor, surface };
}

async function settle(): Promise<void> {
  await settled(4);
}

const historyBar = (surface: ReturnType<typeof createSurface>, block: string): HTMLButtonElement => {
  const bar = surface.element.querySelector<HTMLButtonElement>(`[data-nq-block="${block}"] .nq-bar-history`);
  if (!bar) throw new Error(`no interactive bar for ${block}`);
  return bar;
};

describe("the history filter", () => {
  test("an op touches a block as its target or as the container something landed in", () => {
    expect(opTouchesBlock({ op: "setField", block: "a", key: "k", value: 1 }, "a")).toBe(true);
    expect(opTouchesBlock({ op: "textEdit", block: "a", changes: [] }, "b")).toBe(false);
    expect(opTouchesBlock({ op: "delete", block: "a" }, "a")).toBe(true);
    expect(opTouchesBlock({ op: "setAccess", access: { owner: { actorId: "x", key: "k", kind: "human" }, grants: [], nonce: "n" } }, "a")).toBe(false);
  });

  test("only transactions whose ops touch the block are in its history — exact, one row per transaction", async () => {
    const { editor, surface } = editorWith();
    const a = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    const b = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "b" });
    editor.editText(a, "a2");
    editor.editText(b, "b2");
    editor.editText(a, "a3");
    await settle();

    const touching = transactionsTouching(editor, a);
    // One row per transaction touching a: the insert, then two edits. The
    // two same-actor runs are NOT deduped, and b's transactions are absent.
    expect(touching).toHaveLength(3);
    expect(touching.every(tx => tx.ops.some(op => opTouchesBlock(op, a)))).toBe(true);
    expect(touching.map(tx => tx.lamport)).toEqual([...touching.map(tx => tx.lamport)].sort((x, y) => x - y));
    expect(touching).not.toContain(editor.history().find(tx => tx.ops.some(op => op.op === "textEdit" && op.block === b)));

    const rows = await blockHistoryRows(editor, a);
    expect(rows).toHaveLength(3);
    surface.destroy();
    editor.close();
  });

  test("the panel rows name writers: awareness names for peers, the model for AI", async () => {
    const { editor, surface } = editorWith();
    const a = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "draft" });
    editor.awareness.set("human:tomas", { actor: "human:tomas", name: "Tomás", cursor: null });
    editor.apply({
      id: "peer-edit", actor: { actorId: "human:tomas", kind: "human" }, lamport: 90, causality: {},
      intent: "type", ops: [{ op: "textEdit", block: a, changes: [{ retain: 5 }, { insert: "!" }] }],
    });
    await settle();
    const rows = await blockHistoryRows(editor, a);
    const peer = rows.find(row => row.writer === "Tomás");
    expect(peer).toBeDefined(); // the awareness name, not the raw actor id
    expect(peer ? PEER_INKS.includes(peer.ink!) : false).toBe(true); // the remote human's derived ink, resolved before the panel draws
    const local = rows.find(row => row.writer === "Writer");
    expect(local).toBeUndefined(); // the local writer has no awareness entry: shows by actor id
    expect(rows.find(row => row.writer === "human:writer")).toBeDefined();
    surface.destroy();
    editor.close();
  });
});

describe("the interactive bar and its popover", () => {
  test("the bar is a named button; Enter opens the history popover and Escape returns focus to the bar", async () => {
    const { editor, surface } = editorWith();
    const a = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    await settle();
    const bar = historyBar(surface, a);
    expect(bar.getAttribute("aria-label")).toBe("Block history · last edited by human:writer");
    expect(bar.hasAttribute("title")).toBe(false);
    expect(surface.element.querySelectorAll(".nq-popover").length + document.querySelectorAll("body > .nq-popover").length).toBe(0);

    bar.focus();
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    bar.click(); // Enter on a button clicks it; happy-dom needs the click dispatched
    await settle();
    const popover = document.querySelector("body > .nq-popover .nq-history")?.closest(".nq-popover") as HTMLElement | null;
    expect(popover).not.toBeNull();
    // Exact lamports, one row per transaction (here: the insert).
    const lamports = Array.from(popover!.querySelectorAll(".nq-history-lamport")).map(node => node.textContent);
    expect(lamports).toEqual([`lamport ${transactionsTouching(editor, a).at(-1)!.lamport}`]);
    expect(popover!.querySelector(".nq-history-restore")).toBeNull(); // a live block has no Restore row

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector("body > .nq-popover .nq-history")).toBeNull(); // the history popover closed
    expect(document.activeElement).toBe(bar); // the popover's contract: focus returns to the anchor
    surface.destroy();
    editor.close();
  });

  test("settled suggestions keep their card in the history layer, not the deleted row", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "keep me" });
    await settle();
    await editor.propose({
      ops: [{ op: "textEdit", block: paragraph, changes: [{ retain: 0 }, { delete: 7 }, { insert: "KEEP ME" }] }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settle();
    editor.reject([...Object.values(editor.view.blocks)].find(block => block.type === "nooq.suggestion/v1")!.id);
    await settle();
    const rejected = surface.element.querySelector("article.nq-sugg[data-state='rejected']");
    expect(rejected?.textContent).toContain("kept in history"); // the card keeps rendering its own tombstone
    expect(surface.element.querySelector(".nq-history-layer .nq-block-deleted")).toBeNull(); // not drawn as a deleted row
    surface.destroy();
    editor.close();
  });
});

describe("the deleted flow", () => {
  test("a deleted block renders as the deleted BlockRow and Restore brings it back under its parent", async () => {
    const { editor, surface } = editorWith();
    const parent = editor.insertBlock({ type: "nooq.heading/v1", parent: null, text: "section" });
    const child = editor.insertBlock({ type: "nooq.paragraph/v1", parent, text: "under the heading" });
    await settle();
    editor.deleteBlock(child);
    await settle();

    const row = surface.element.querySelector(".nq-history-layer .nq-block-deleted") as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row!.querySelector("del")?.textContent).toContain("under the heading");
    expect(row!.textContent).toContain("Deleted"); // DM-3.4: no later edits yet

    expect(restoreParentOf(editor, child)).toBe(parent); // the last-known, still-alive parent
    expect(liveTree(editor.view).alive.has(child)).toBe(false);
    row!.querySelector<HTMLButtonElement>(".nq-tomb-meta .nq-btn")!.click(); // Restore, through the surface
    await settle();
    expect(liveTree(editor.view).alive.has(child)).toBe(true);
    expect(editor.view.blocks[parent]!.children).toContain(child);
    expect(surface.element.querySelector(".nq-history-layer .nq-block-deleted")).toBeNull();
    surface.destroy();
    editor.close();
  });

  test("later edits after the delete are counted, exactly (DM-4.8)", async () => {
    const { editor, surface } = editorWith();
    const a = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    await settle();
    editor.deleteBlock(a);
    editor.setField(a, "note", "kept with the tombstone"); // a concurrent writer's edit, restored with the block
    await settle();
    expect(laterEditsOf(editor, a)).toBe(1);
    const row = surface.element.querySelector(".nq-history-layer .nq-block-deleted") as HTMLElement | null;
    expect(row?.textContent).toContain("Deleted with 1 later edit");
    surface.destroy();
    editor.close();
  });
});
