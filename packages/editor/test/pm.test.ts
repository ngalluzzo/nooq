import { describe, expect, test } from "bun:test";
import { TextSelection } from "prosemirror-state";
import { Editor } from "../src/controller.ts";
import { createPmSurface, pmDocFromProjection, textblocksOf } from "../src/pm-surface.ts";

const marks = (s: string): string[][] => s.split("").map(() => []);
/** onChange is microtask-deferred (scheduleNotify); flush before asserting. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function editorWith(paragraph: string, second?: string): { editor: Editor; blockId: string; secondId?: string } {
  const editor = new Editor({ docId: "pm-spike-doc", actor: { actorId: "human:pm", name: "pm" } });
  const blockId = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: paragraph });
  let secondId: string | undefined;
  if (second !== undefined) {
    secondId = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: second });
  }
  return { editor, blockId, secondId };
}

describe("the ProseMirror surface (proposal 0003 spike)", () => {
  test("the projection maps the block tree at near-identity (§4)", () => {
    const { editor, blockId } = editorWith("hello");
    const sectionId = editor.insertBlock({ type: "nooq.section/v1", parent: null, fields: { depth: 1 } });
    editor.insertBlock({ type: "nooq.heading/v1", parent: sectionId, text: "nested" });

    const doc = pmDocFromProjection(editor.view);
    // doc > paragraph, section > heading — the forest stays a forest.
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).attrs.blockId).toBe(blockId);
    expect(doc.child(0).textContent).toBe("hello");
    const sec = doc.child(1);
    expect(sec.type.name).toBe("section");
    expect(sec.childCount).toBe(1);
    expect(sec.child(0).type.name).toBe("heading");
    expect(sec.child(0).textContent).toBe("nested");
  });

  test("local typing diffs into per-block DM-4.3 splices — one keystroke, one splice transaction (§1)", async () => {
    const { editor, blockId } = editorWith("noo");
    const surface = createPmSurface(editor);
    const info = textblocksOf(surface.state.doc).find((b) => b.id === blockId)!;

    // one keystroke: 'q' at the end of "noo"
    surface.dispatch(surface.state.tr.insertText("q", info.end));
    const tx = editor.view.log.at(-1)!;
    expect(tx.ops).toEqual([{ op: "textEdit", block: blockId, changes: [{ retain: 3 }, { insert: "q" }] }]);
    expect(editor.view.blocks[blockId]!.text!.s).toBe("nooq");

    // a mid-word delete: "nooq" minus the 'o' at index 1 = "noq"
    surface.dispatch(surface.state.tr.delete(info.start + 1, info.start + 2));
    expect(editor.view.blocks[blockId]!.text!.s).toBe("noq");
    surface.destroy();
  });

  test("multi-block typing routes splices to the right blocks only", () => {
    const { editor, blockId, secondId } = editorWith("first", "second");
    const surface = createPmSurface(editor);
    const blocks = textblocksOf(surface.state.doc);
    const second = blocks.find((b) => b.id === secondId)!;

    surface.dispatch(surface.state.tr.insertText("!", second.end));
    expect(editor.view.blocks[secondId!]!.text!.s).toBe("second!");
    expect(editor.view.blocks[blockId]!.text!.s).toBe("first"); // untouched
    surface.destroy();
  });

  test("remote splices patch the PM doc and the selection rides the step maps (EB-7.1)", async () => {
    const { editor, blockId } = editorWith("0123456789");
    const surface = createPmSurface(editor);
    surface.setCursor(5, blockId);
    expect(surface.selectionAnchor()).toEqual({ block: blockId, offset: 5 });

    // A peer inserts "XY" at offset 2 — under the caret's characters.
    editor.applyTextChanges(blockId, [{ retain: 2 }, { insert: "XY" }]);
    await flush();
    const info = textblocksOf(surface.state.doc).find((b) => b.id === blockId)!;
    expect(info.text).toBe("01XY23456789");
    // The caret mapped forward through the step: still between 4 and 5.
    const afterInsert = surface.selectionAnchor();
    expect(afterInsert).toEqual({ block: blockId, offset: 7 });

    // A peer deletes the range covering the caret ("4567" at offsets 5..8).
    editor.applyTextChanges(blockId, [{ retain: 5 }, { delete: 4 }]);
    await flush();
    // Caret collapses to the splice point — PM maps deleted positions to the cut.
    expect(surface.selectionAnchor()).toEqual({ block: blockId, offset: 5 });
    surface.destroy();
  });

  test("presence anchors resolve through the current doc (SW-7)", async () => {
    const { editor, blockId } = editorWith("abcdef");
    const surface = createPmSurface(editor);
    // Offset 3 addresses the character after index 2 — textBetween(pos, pos+1) = index 3 = 'd'.
    const pos = surface.anchorToPos({ block: blockId, offset: 3 })!;
    expect(surface.state.doc.textBetween(pos, pos + 1)).toBe("d");

    editor.applyTextChanges(blockId, [{ retain: 2 }, { insert: "XY" }]);
    await flush();
    // A flat offset re-addresses in the new text (index 2 is now 'X');
    // identity stability comes from the block id + step-mapped selection
    // (EB-7.1, previous test), not from the offset arithmetic — exactly why
    // SW-7 anchors carry block identity and the binding owns the mapping.
    const mapped = surface.anchorToPos({ block: blockId, offset: 2 })!;
    expect(surface.state.doc.textBetween(mapped, mapped + 1)).toBe("X");
    surface.destroy();
  });

  test("structure changes re-derive the projection wholesale", async () => {
    const { editor, blockId } = editorWith("stay");
    const surface = createPmSurface(editor);
    editor.deleteBlock(blockId);
    const freshId = editor.insertBlock({ type: "nooq.heading/v1", parent: null, text: "new" });
    await flush();

    const blocks = textblocksOf(surface.state.doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe(freshId);
    expect(blocks[0]!.text).toBe("new");
    surface.destroy();
  });
});

void TextSelection;
