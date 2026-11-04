import { describe, expect, test } from "bun:test";
import { essentials, moveBlock } from "@nooq/plugins/essentials";
import { Editor } from "../../editor/src/index.ts";

/** Tier-1 drag handle: the command (the gesture's every path ends here). */
describe("the move command (nooq.block.move)", () => {
  const editor = () => new Editor({ docId: "drag", actor: { actorId: "w" }, plugins: [essentials] });

  test("reorders within the same parent; a branch moves as a branch", () => {
    const e = editor();
    const a = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    const b = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "b" });
    const c = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "c" });
    expect(e.view.roots).toEqual([a, b, c]);
    e.commands.run(moveBlock, { block: c, parent: null, index: 0 });
    expect(e.view.roots).toEqual([c, a, b]);
    // The branch: move b under a with a child
    const kid = e.insertBlock({ type: "nooq.paragraph/v1", parent: b, text: "kid" });
    e.commands.run(moveBlock, { block: b, parent: a, index: 0 });
    expect(e.view.blocks[a]!.children).toEqual([b]);
    expect(e.view.blocks[b]!.children).toEqual([kid]); // subtree intact
    e.close();
  });

  test("cross-parent moves land where the line said (index semantics)", () => {
    const e = editor();
    const col1 = e.insertBlock({ type: "nooq.column/v1", parent: null });
    const col2 = e.insertBlock({ type: "nooq.column/v1", parent: null });
    const p1 = e.insertBlock({ type: "nooq.paragraph/v1", parent: col1, text: "one" });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: col1, text: "two" });
    const moved = e.commands.run(moveBlock, { block: p1, parent: col2, index: 0 });
    expect(moved.status).toBe("applied");
    expect(e.view.blocks[col2]!.children).toContain(p1);
    e.close();
  });

  test("guards: never under itself; a no-op move is not a transaction", () => {
    const e = editor();
    const a = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    const kid = e.insertBlock({ type: "nooq.paragraph/v1", parent: a, text: "k" });
    expect(e.commands.run(moveBlock, { block: a, parent: a, index: 0 }).status).toBe("not-applicable");
    expect(e.commands.run(moveBlock, { block: a, parent: kid, index: 0 }).status).toBe("not-applicable");
    expect(e.commands.run(moveBlock, { block: a, parent: null, index: 0 }).status).toBe("not-applicable");
    e.close();
  });

  test("moves are ordinary transactions: the reciprocal move restores order", () => {
    // Undo is DM-14's restore (per block, through history), not a linear
    // stack; the transaction property under it: one move, one reciprocal,
    // exactly the original tree.
    const e = editor();
    const a = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "a" });
    const b = e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "b" });
    e.commands.run(moveBlock, { block: b, parent: null, index: 0 });
    expect(e.view.roots).toEqual([b, a]);
    e.commands.run(moveBlock, { block: b, parent: null, index: 1 });
    expect(e.view.roots).toEqual([a, b]);
    e.close();
  });
});
