import { describe, expect, test } from "bun:test";
import { applyTransaction, emptyDocument, liveTree, makeBlock } from "../src/index.ts";
import { buildFixture, rt, tx } from "./helpers.ts";

describe("applyTransaction (DM-4, sequential v0)", () => {
  test("builds a document and maintains order", async () => {
    const { state, section, q, p, h } = await buildFixture();
    expect(state.roots).toEqual([section]);
    expect(state.blocks[section]!.children).toEqual([q, p, h]);
    expect("log" in state).toBe(false); // history lives outside state (DM-14.4)
  });

  test("move repositions within and across parents", async () => {
    const { state, section, q, p, h } = await buildFixture();
    const moved = applyTransaction(state, tx([{ op: "move", block: h, newParent: section, index: 0 }], 5));
    expect(moved.blocks[section]!.children).toEqual([h, q, p]);

    const other = makeBlock({ type: "nooq.section/v1" }, "human:1");
    const out = applyTransaction(moved, tx([{ op: "insert", block: other, parent: null }, { op: "move", block: p, newParent: other.id }], 6));
    expect(out.blocks[other.id]!.children).toEqual([p]);
    expect(out.blocks[section]!.children).toEqual([h, q]);
    expect(out.roots).toEqual([section, other.id]);
  });

  test("delete tombstones; the map entry survives (DM-3.4)", async () => {
    const { state, section, q, p, h } = await buildFixture();
    const deleted = applyTransaction(state, tx([{ op: "delete", block: p }], 5));
    expect(deleted.blocks[section]!.children).toEqual([q, h]);
    expect(deleted.blocks[p]).toBeDefined();
    expect(liveTree(deleted).alive.has(p)).toBe(false);
  });

  test("restore reattaches a tombstone with its content (DM-4.6)", async () => {
    const { state, section, q, p, h } = await buildFixture();
    const deleted = applyTransaction(state, tx([{ op: "delete", block: p }], 5));
    const restored = applyTransaction(deleted, tx([{ op: "restore", block: p, parent: section }], 6));
    expect(restored.blocks[section]!.children).toEqual([q, h, p]);
    expect(restored.blocks[p]!.text!.s).toBe("hello world");
  });

  test("rejects duplicate block ids", async () => {
    const { state, q } = await buildFixture();
    const again = structuredClone(state.blocks[q]!);
    expect(() => applyTransaction(state, tx([{ op: "insert", block: again, parent: null }], 5))).toThrow(/already exists/);
  });

  test("rejects moving a block into its own subtree (DM-3.1)", async () => {
    const { state, section, p } = await buildFixture();
    expect(() => applyTransaction(state, tx([{ op: "move", block: section, newParent: p }], 5))).toThrow(/own subtree/);
  });

  test("rejects operations on tombstoned blocks", async () => {
    const { state, section, q, p, h } = await buildFixture();
    const deleted = applyTransaction(state, tx([{ op: "delete", block: p }], 5));
    expect(() => applyTransaction(deleted, tx([{ op: "delete", block: p }], 6))).toThrow(/tombstoned/);
    expect(() => applyTransaction(deleted, tx([{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1" }, "human:1"), parent: p }], 6))).toThrow(/tombstoned/);
    void section; void q; void h;
  });

  test("text changes are positional: lenient tail, strict ranges (DM-4.3)", async () => {
    const { state, p } = await buildFixture();
    // p is "hello world" (11 chars). Trailing retains may be omitted:
    // an early stop leaves the remainder untouched.
    const trimmed = applyTransaction(state, tx([{ op: "textEdit", block: p, changes: [{ delete: 5 }, { insert: "ab" }] }], 5));
    expect(trimmed.blocks[p]!.text!.s).toBe("ab world");
    // Out-of-range steps are malformed.
    expect(() =>
      applyTransaction(state, tx([{ op: "textEdit", block: p, changes: [{ retain: 12 }] }], 5)),
    ).toThrow(/out of range/);
    // Empty changes are a no-op.
    const untouched = applyTransaction(state, tx([{ op: "textEdit", block: p, changes: [] }], 5));
    expect(untouched.blocks[p]!.text!.s).toBe("hello world");
  });

  test("immutability: the input state is untouched", async () => {
    const { state, p } = await buildFixture();
    const before = structuredClone(state);
    applyTransaction(state, tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 5));
    expect(state).toEqual(before);
  });

  test("attribution records writers per field and text (DM-5)", async () => {
    const { state, p } = await buildFixture();
    const edited = applyTransaction(
      state,
      tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 7, "human:2"),
    );
    expect(edited.blocks[p]!.attribution.fields["tone"]).toEqual({ actor: "human:2", lamport: 7 });

    const retyped = applyTransaction(
      edited,
      tx([{ op: "textEdit", block: p, changes: [{ retain: 11 }, { insert: "!" }] }], 8, "ai:1"),
    );
    // Text authorship is per character, by client (DM-14.2): never a block-level rewrite.
    expect(Object.keys(retyped.blocks[p]!.attribution).sort()).toEqual(["created", "fields"]);
    expect(retyped.blocks[p]!.attribution.created).toEqual({ actor: "human:1" });
  });

  test("a failing transaction changes nothing", async () => {
    const { state, p } = await buildFixture();
    const before = structuredClone(state);
    expect(() =>
      applyTransaction(state, tx([
        { op: "setField", block: p, key: "tone", value: "urgent" },
        { op: "setField", block: "nope", key: "x", value: 1 },
      ], 5)),
    ).toThrow(/no such block/);
    expect(state).toEqual(before);
  });
});
