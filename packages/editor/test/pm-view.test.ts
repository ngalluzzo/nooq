import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { liveTree } from "@nooq/core";
import { Editor } from "../src/controller.ts";
import { TextSelection } from "prosemirror-state";
import { createPmView } from "../src/pm-view.ts";
import { textblocksOf } from "../src/pm-surface.ts";

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function mounted(...texts: string[]) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({ docId: "pm-view-doc", actor: { actorId: "human:pm", name: "pm" } });
  const ids = texts.map((t) => editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: t }));
  const surface = createPmView(editor, host);
  return { editor, surface, host, ids };
}

/** Real key event through PM's DOM pipeline (keymap path). */
function key(surface: ReturnType<typeof mounted>["surface"], k: string, mod = false): void {
  surface.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...(mod ? { ctrlKey: true } : {}) }),
  );
}

describe("the EditorView wrapper (proposal 0003, step two)", () => {
  test("mounts and renders the projection as contenteditable DOM", () => {
    const { surface, host } = mounted("hello world");
    expect(surface.dom.getAttribute("contenteditable")).toBe("true");
    expect(host.textContent).toContain("hello world");
    surface.destroy();
  });

  test("Enter splits the block in ONE nooq transaction, caret lands in the new block (§1)", async () => {
    const { editor, surface, ids } = mounted("nooq editors");
    surface.surface.setCursor(4, ids[0]!); // between "nooq" and " editors"
    const logBefore = editor.history().length;

    key(surface, "Enter");
    await flush();

    // One transaction, two ops (tail splice + insert) — atomic structure (§1).
    expect(editor.history().length).toBe(logBefore + 1);
    const tx = editor.history().at(-1)!;
    expect(tx.ops).toHaveLength(2);
    expect(tx.ops[0]).toMatchObject({ op: "textEdit", block: ids[0] });
    expect(tx.ops[1]).toMatchObject({ op: "insert" });

    // The projection now shows two blocks with the split text.
    const blocks = textblocksOf(surface.surface.state.doc);
    expect(blocks.map((b) => b.text)).toEqual(["nooq", " editors"]);
    // The caret rode the rebuild into the new block.
    const anchor = surface.surface.selectionAnchor();
    expect(anchor).toEqual({ block: (tx.ops[1] as { block: { id: string } }).block.id, offset: 0 });
    surface.destroy();
  });

  test("Backspace at offset 0 merges into the previous sibling; caret at the seam", async () => {
    const { editor, surface, ids } = mounted("ab", "cd");
    surface.surface.setCursor(0, ids[1]!);
    const logBefore = editor.history().length;

    key(surface, "Backspace");
    await flush();

    expect(editor.history().length).toBe(logBefore + 1);
    const tx = editor.history().at(-1)!;
    expect(tx.ops[0]).toMatchObject({ op: "textEdit", block: ids[0] });
    expect(tx.ops[1]).toMatchObject({ op: "delete", block: ids[1] });

    const blocks = textblocksOf(surface.surface.state.doc);
    expect(blocks.map((b) => b.text)).toEqual(["abcd"]);
    expect(surface.surface.selectionAnchor()).toEqual({ block: ids[0], offset: 2 });
    surface.destroy();
  });

  test("Backspace at the very start of the document does nothing (§2)", async () => {
    const { editor, surface, ids } = mounted("only block");
    surface.surface.setCursor(0, ids[0]!);
    const logBefore = editor.history().length;
    key(surface, "Backspace");
    await flush();
    expect(editor.history().length).toBe(logBefore);
    surface.destroy();
  });

  test("remote changes reach the DOM and the caret rides the splice maps (EB-7.1)", async () => {
    const { editor, surface, ids } = mounted("0123456789");
    surface.surface.setCursor(5, ids[0]!);
    editor.applyTextChanges(ids[0]!, [{ retain: 2 }, { insert: "XY" }]);
    await flush();
    expect(surface.dom.textContent).toContain("01XY23456789");
    expect(surface.surface.selectionAnchor()).toEqual({ block: ids[0], offset: 7 });
    surface.destroy();
  });

  test("Ctrl-B over a selection diff into setMarks — one transaction, no text damage (§1, DM-3.3)", async () => {
    const { editor, surface, ids } = mounted("make this shine");
    surface.surface.setCursor(5, ids[0]!);
    const view = surface.view;
    // select "this"
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, surface.surface.anchorToPos({ block: ids[0]!, offset: 5 })!, surface.surface.anchorToPos({ block: ids[0]!, offset: 9 })!)));
    key(surface, "b", true);
    await flush();

    expect(surface.dom.querySelector("strong")?.textContent).toBe("this");
    const tx = editor.history().at(-1)!;
    expect(tx.ops).toEqual([{ op: "textEdit", block: ids[0], changes: [{ retain: 5 }, { retain: 4, setMarks: ["strong"] }] }]);
    expect(editor.view.blocks[ids[0]!]!.text!.s).toBe("make this shine"); // text untouched
    expect(editor.view.blocks[ids[0]!]!.text!.marks[6]).toEqual(["strong"]);
    surface.destroy();
  });

  test("remote setMarks renders <strong> in the DOM and the caret survives (EB-7.1)", async () => {
    const { editor, surface, ids } = mounted("0123456789");
    surface.surface.setCursor(7, ids[0]!);
    editor.applyTextChanges(ids[0]!, [{ retain: 2 }, { retain: 3, setMarks: ["em"] }]);
    await flush();
    expect(surface.dom.querySelector("em")?.textContent).toBe("234");
    expect(surface.surface.selectionAnchor()).toEqual({ block: ids[0], offset: 7 });
    surface.destroy();
  });

  test("Enter preserves the tail's marks; merge preserves the merged text's marks", async () => {
    const { editor, surface, ids } = mounted("plain bold");
    editor.applyTextChanges(ids[0]!, [{ retain: 6 }, { retain: 4, setMarks: ["strong"] }]);
    await flush();

    // split at the start of the bold tail ("bold" begins at offset 6)
    surface.surface.setCursor(6, ids[0]!);
    key(surface, "Enter");
    await flush();
    const split = editor.history().at(-1)!;
    const newId = (split.ops[1] as { block: { id: string } }).block.id;
    expect(editor.view.blocks[newId]!.text!.s).toBe("bold");
    expect(editor.view.blocks[newId]!.text!.marks[0]).toEqual(["strong"]); // tail kept its bold

    // merge it back: bold text stays bold after the merge
    surface.surface.setCursor(0, newId);
    await flush();
    key(surface, "Backspace");
    await flush();
    expect(editor.view.blocks[ids[0]!]!.text!.s).toBe("plain bold");
    expect(editor.view.blocks[ids[0]!]!.text!.marks[7]).toEqual(["strong"]);
    surface.destroy();
  });

  test("selectionRange reports ordered block anchors (SW-7 shape)", async () => {
    const { surface, ids } = mounted("alpha", "beta");
    const view = surface.view;
    const from = surface.surface.anchorToPos({ block: ids[0]!, offset: 3 })!;
    const to = surface.surface.anchorToPos({ block: ids[1]!, offset: 2 })!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    expect(surface.surface.selectionRange()).toEqual({
      head: { block: ids[0], offset: 3 },
      tail: { block: ids[1], offset: 2 },
    });
    surface.destroy();
  });

  test("typing over a cross-block selection joins in ONE nooq transaction (§1)", async () => {
    const { editor, surface, ids } = mounted("make this", "that shine", "third block");
    // bold the head's KEPT prefix so both preservation and caret-inheritance
    // are proven through the join ("make " = indices 0..4)
    editor.applyTextChanges(ids[0]!, [{ retain: 5, setMarks: ["strong"] }]);
    await flush();

    const view = surface.view;
    const from = surface.surface.anchorToPos({ block: ids[0]!, offset: 5 })!;
    const to = surface.surface.anchorToPos({ block: ids[2]!, offset: 6 })!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const logBefore = editor.history().length;

    // The browser's input pipeline calls handleTextInput before mutating; a
    // synthetic keydown cannot reproduce that, so drive the prop directly
    // (the same seam PM's own tests use).
    const handleTextInput = surface.view.someProp("handleTextInput") as ((view: unknown, from: number, to: number, text: string) => boolean) | undefined;
    const handled = handleTextInput?.(surface.view, from, to, "X");
    expect(handled).toBe(true);
    await flush();

    expect(editor.history().length).toBe(logBefore + 1);
    const tx = editor.history().at(-1)!;
    // textEdit head + delete tail + delete middle
    expect(tx.ops.filter((op) => op.op === "delete")).toHaveLength(2);
    const editText = tx.ops.find((op) => op.op === "textEdit");
    expect(editText).toMatchObject({ block: ids[0] });

    // Result: one live joined block; bold prefix intact; the typed X
    // INHERITED the caret's bold; middle and tail are tombstones.
    const text = editor.view.blocks[ids[0]!]!.text!;
    expect(text.s).toBe("make Xblock"); // kept prefix + X + tail remainder (middle gone)
    expect(text.marks[0]).toEqual(["strong"]); // prefix stayed bold
    expect(text.marks[5]).toEqual(["strong"]); // X inherited the caret's marks
    const alive = liveTree(editor.view).alive;
    expect(alive.has(ids[1]!)).toBe(false); // tombstoned (DM-3.4)
    expect(alive.has(ids[2]!)).toBe(false);
    expect(surface.surface.selectionAnchor()).toEqual({ block: ids[0], offset: 6 });
    surface.destroy();
  });

  test("Backspace over a cross-block selection deletes and joins (§1)", async () => {
    const { editor, surface, ids } = mounted("alpha", "beta");
    const view = surface.view;
    const from = surface.surface.anchorToPos({ block: ids[0]!, offset: 2 })!;
    const to = surface.surface.anchorToPos({ block: ids[1]!, offset: 1 })!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const logBefore = editor.history().length;

    key(surface, "Backspace");
    await flush();

    expect(editor.history().length).toBe(logBefore + 1);
    expect(editor.view.blocks[ids[0]!]!.text!.s).toBe("aleta"); // "al" + remainder "eta"
    expect(liveTree(editor.view).alive.has(ids[1]!)).toBe(false); // tombstoned, not erased (DM-3.4)
    expect(surface.surface.selectionAnchor()).toEqual({ block: ids[0], offset: 2 });
    surface.destroy();
  });

  test("typing through the view enters nooq as splices (§1, end to end)", async () => {
    const { editor, surface, ids } = mounted("type");
    const view = surface.view;
    surface.surface.setCursor(4, ids[0]!); // caret at the end of "type"
    const at = view.state.selection.to;
    view.dispatch(view.state.tr.insertText("d", at));
    await flush();
    const tx = editor.history().at(-1)!;
    const blockId = (tx.ops[0] as { block: string }).block;
    expect(tx.ops).toEqual([{ op: "textEdit", block: blockId, changes: [{ retain: 4 }, { insert: "d" }] }]);
    expect(surface.dom.textContent).toContain("typed");
    surface.destroy();
  });
});
