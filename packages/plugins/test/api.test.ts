import { expect, test } from "bun:test";
import { emptyDocument, makeBlock } from "@nooq/core";
import { defineBlock, defineCommand, definePlugin, prepareCommand } from "../src/index.ts";

const block = defineBlock({ type: "test.note/v1", label: "Note", text: "inline", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
const actor = { actorId: "human", kind: "human" as const };

test("registry rejects conflicts and detaches contribution arrays", () => {
  const blocks = [block];
  const plugin = definePlugin({ id: "test", version: "1", apiVersion: 1, contributes: { blocks, commands: [] } });
  blocks.length = 0;
  expect(plugin.contributes.blocks).toHaveLength(1);
  expect(() => definePlugin({ ...plugin, contributes: { blocks: [block, block], commands: [] } })).toThrow("Duplicate");
  expect(Object.isFrozen(plugin.contributes.blocks)).toBe(true);
});

test("typed and dynamic dispatch validate arguments before preparation", () => {
  let called = false;
  const cmd = defineCommand<{ block: string }>({ id: "check", label: "Check", validateArgs: (x): x is { block: string } => typeof x === "object" && x !== null && "block" in x && typeof x.block === "string", prepare: () => { called = true; return { status: "not-applicable" }; } });
  const plugin = definePlugin({ id: "test", version: "1", apiVersion: 1, contributes: { blocks: [block], commands: [cmd] } });
  expect(() => prepareCommand(plugin, "check", emptyDocument("open"), actor, {})).toThrow("Invalid arguments");
  expect(called).toBe(false);
});

test("snapshot is recursively frozen and block creation binds the host actor", () => {
  const state = emptyDocument("open");
  state.blocks.old = makeBlock({ id: "old", type: block.type, fields: { nested: { value: 1 } } }, "previous");
  const before = structuredClone(state);
  const cmd = defineCommand<null>({ id: "create", label: "Create", validateArgs: (x): x is null => x === null, prepare(ctx) {
    expect(Object.isFrozen(ctx.snapshot.blocks.old!.fields.nested)).toBe(true);
    expect(ctx.isAlive("old")).toBe(false);
    expect(ctx.actor.plugin).toBe("test");
    const a = ctx.createBlock(block.type), b = ctx.createBlock(block.type);
    expect(a.id).not.toBe(b.id);
    expect(a.attribution.created.actor).toBe(actor.actorId);
    return { status: "ready", intent: "create", ops: [{ op: "insert", block: a, parent: null }] };
  } });
  const plugin = definePlugin({ id: "test", version: "1", apiVersion: 1, contributes: { blocks: [block], commands: [cmd] } });
  expect(prepareCommand(plugin, "create", state, actor, null).status).toBe("ready");
  expect(state).toEqual(before); // Preparation does not commit or allocate a transaction.
});

test("async command implementations fail the synchronous boundary", () => {
  const plugin = definePlugin({ id: "test", version: "1", apiVersion: 1, contributes: { blocks: [], commands: [{ id: "bad", label: "Bad", validateArgs: (x): x is null => x === null,
    // @ts-expect-error Deliberately invalid JavaScript consumer.
    prepare: async () => ({ status: "not-applicable" }),
  }] } });
  expect(() => prepareCommand(plugin, "bad", emptyDocument("open"), actor, null)).toThrow("synchronous");
});
