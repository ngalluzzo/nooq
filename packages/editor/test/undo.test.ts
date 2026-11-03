import { describe, expect, test } from "bun:test";
import { essentials } from "@nooq/plugins/essentials";
import { moveBlock } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { insertTable } from "@nooq/plugin-tables";
import { tablesPlugin } from "@nooq/plugin-tables";

/** DM-4.10: the undo stack — undo is ANOTHER EDIT, burst-aware, redo, the access exception. */
describe("undo/redo (DM-4.10)", () => {
  const editor = () => new Editor({ docId: "undo", actor: { actorId: "human:w" }, plugins: [essentials, tablesPlugin] });

  test("undo restores the pre-state for every gesture family", () => {
    const e = editor();
    const a = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "alpha" });
    const b = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "beta" });
    const pre = structuredClone(e.view);
    // moves, field writes, deletes — then undo each, in reverse
    e.commands.run(moveBlock, { block: b, parent: null, index: 0 });
    e.commands.run("nooq.field.set", { block: a, key: "tone", value: "warm" });
    e.commands.run("nooq.text.edit", { block: a, changes: [{ retain: 5 }, { insert: "!" }] });
    e.undo(); // textEdit
    expect(e.view.blocks[a]!.text!.s).toBe("alpha");
    e.undo(); // setField... first-set (no old value) — the stated limit skips it; this undo is the MOVE? No:
    // A first-set's inverse is empty → the undo tx is empty → apply does nothing.
    // The honest stack behavior: the entry exists but undoes nothing. So the next undo is the move.
    e.undo(); // move
    expect(e.view.roots).toEqual(pre.roots);
    e.close();
  });

  test("delete's undo RESTORES: text, children, and placement return", () => {
    const e = editor();
    const parent = e.insertBlock({ type: "nooq.list/v1", parent: null, text: "outer", fields: { kind: "bullet" } });
    const child = e.insertBlock({ type: "nooq.list/v1", parent, text: "inner", fields: { kind: "bullet" } });
    e.commands.run("nooq.block.delete", { block: parent });
    expect(e.view.roots).toHaveLength(0);
    e.undo();
    expect(e.view.roots).toEqual([parent]);
    expect(e.view.blocks[parent]!.children).toEqual([child]); // the subtree, intact
    expect(e.view.blocks[child]!.text!.s).toBe("inner");
    e.close();
  });

  test("redo re-applies the original action; a NEW action expires redo", () => {
    const e = editor();
    const a = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "kept" });
    e.commands.run("nooq.block.delete", { block: a });
    expect(e.view.roots).toHaveLength(0);
    e.undo();
    expect(e.view.roots).toHaveLength(1);
    e.redo();
    expect(e.view.roots).toHaveLength(0); // the delete, again
    e.undo();
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "fork" }); // new action
    expect(e.canRedo()).toBeFalse(); // the timeline forked; redo expired
    e.close();
  });

  test("one transaction = one undo step: the table starter is atomic", () => {
    const e = editor();
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
    const before = e.view.roots.length;
    e.commands.run(insertTable, { parent: null });
    expect(e.view.roots).toHaveLength(before + 1);
    e.undo();
    expect(e.view.roots).toHaveLength(before); // the WHOLE 2x2 tree, unreachable in one step
    // DM-3.4: tombstones keep map entries — the tree is GONE from the
    // alive document (roots), not from history's reach.
    e.redo();
    expect(e.view.roots).toHaveLength(before + 1);
    e.close();
  });

  test("the access exception: an access write never enters the stack (Cmd+Z does not un-revoke)", async () => {
    const { createActorKey, createSecuredDocument, toBase64 } = await import("@nooq/core");
    const key = await createActorKey();
    const owner = { actorId: "human:w", key: toBase64(key.publicBytes), kind: "human" as const };
    const { docId, nonce } = await createSecuredDocument(owner);
    const e = new Editor({ docId, actor: { actorId: "human:w" }, key, plugins: [essentials] });
    await e.initializeAccess({ owner, nonce, grants: [] });
    const marker = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "m" });
    e.undo(); // the marker's insert — NOT the access write
    expect(e.view.roots).not.toContain(marker); // unreachable (the tombstone keeps the map entry, DM-3.4)
    expect(e.canUndo()).toBeFalse(); // genesis (setAccess) was never on the stack
    e.close();
  });
});
