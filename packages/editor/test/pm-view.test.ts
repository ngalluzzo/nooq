import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { Editor } from "../src/controller.ts";
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
function key(surface: ReturnType<typeof mounted>["surface"], k: string): void {
  surface.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
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
    const logBefore = editor.view.log.length;

    key(surface, "Enter");
    await flush();

    // One transaction, two ops (tail splice + insert) — atomic structure (§1).
    expect(editor.view.log.length).toBe(logBefore + 1);
    const tx = editor.view.log.at(-1)!;
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
    const logBefore = editor.view.log.length;

    key(surface, "Backspace");
    await flush();

    expect(editor.view.log.length).toBe(logBefore + 1);
    const tx = editor.view.log.at(-1)!;
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
    const logBefore = editor.view.log.length;
    key(surface, "Backspace");
    await flush();
    expect(editor.view.log.length).toBe(logBefore);
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

  test("typing through the view enters nooq as splices (§1, end to end)", async () => {
    const { editor, surface, ids } = mounted("type");
    const view = surface.view;
    surface.surface.setCursor(4, ids[0]!); // caret at the end of "type"
    const at = view.state.selection.to;
    view.dispatch(view.state.tr.insertText("d", at));
    await flush();
    const tx = editor.view.log.at(-1)!;
    const blockId = (tx.ops[0] as { block: string }).block;
    expect(tx.ops).toEqual([{ op: "textEdit", block: blockId, changes: [{ retain: 4 }, { insert: "d" }] }]);
    expect(surface.dom.textContent).toContain("typed");
    surface.destroy();
  });
});
