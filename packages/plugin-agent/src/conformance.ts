/** Trusted oracle bundled with the candidate, executed only in the sandbox. */
import { strict as assert } from "node:assert";
import { applyTransaction, emptyDocument, makeBlock, canonicalJson } from "@nooq/core";
import type { Block, DocState, Op, Transaction } from "@nooq/core";
import { definePlugin, freezeSnapshot, prepareCommand } from "@nooq/plugins";
import type { Plugin } from "@nooq/plugins";
import { applyTransaction as applyY, newDocument, readState } from "@nooq/yjs";
import * as Y from "yjs";
import type { Brief } from "./brief.ts";

export interface Check { name: string; ok: boolean; error?: string }
export interface Conformance { checks: Check[]; preview?: Block }

export function runConformance(candidate: Plugin, brief: Brief): Conformance {
  const checks: Check[] = [];
  let preview: Block | undefined;
  const check = (name: string, fn: () => void) => {
    try { fn(); checks.push({ name, ok: true }); }
    catch (e) { checks.push({ name, ok: false, error: String(e).slice(0, 2500) }); }
  };
  const actor = { actorId: "test-human", kind: "human" as const, plugin: brief.id };
  let clock = 0;
  const tx = (ops: readonly Op[]): Transaction => ({ id: `tx-${++clock}`, actor, lamport: clock, causality: {}, intent: "conformance", ops: [...ops] });
  const target = crypto.randomUUID();
  const commandArgs = (args: object) => ({ ...args, block: target });
  const fixture = (fields = brief.defaults.fields, type = brief.blockType): DocState => {
    const block = makeBlock({ id: target, type, fields: { ...fields, futureField: { preserved: true } }, text: { s: "A😀B", marks: [[], ["future-mark"], ["future-mark"], []] } }, actor.actorId);
    const child = makeBlock({ id: "fixture-child", type: "unknown.child/v7", fields: { keep: true } }, actor.actorId);
    return applyTransaction(emptyDocument("plugin-test-open-document"), tx([{ op: "insert", block, parent: null }, { op: "insert", block: child, parent: target }]));
  };
  const plugin = definePlugin(candidate);
  const definition = plugin.contributes.blocks[0]!;
  check("manifest and contribution identity", () => {
    assert.equal(plugin.id, brief.id);
    assert.equal(plugin.apiVersion, 1);
    assert.equal(plugin.contributes.blocks.length, 1);
    assert.equal(definition.type, brief.blockType);
    assert.equal(definition.text, "inline");
    assert.deepEqual(plugin.contributes.commands.map(c => c.id).sort(), [...brief.commands.map(c => c.id), ...(brief.insertCommand ? [brief.insertCommand.id] : [])].sort());
  });
  check("creation defaults and fresh data", () => {
    const first = definition.create();
    assert.deepEqual(first, { fields: brief.defaults.fields, text: { s: brief.defaults.text, marks: Array.from({ length: brief.defaults.text.length }, () => []) } });
    const block = makeBlock({ type: definition.type, ...first }, actor.actorId);
    first.fields.__probe = true;
    assert.equal(definition.create().fields.__probe, undefined);
    assert.equal(block.fields.__probe, undefined);
    preview = block;
  });
  brief.diagnostics.forEach((d, i) => check(`diagnostics ${i + 1}: pure and repeatable`, () => {
    const block = fixture(d.fields).blocks[target]!;
    const before = structuredClone(block);
    const issues = definition.diagnose(freezeSnapshot(block));
    assert.deepEqual(issues.map(d => d.field).sort(), [...d.expectedFields].sort());
    assert.ok(issues.every(d => typeof d.message === "string" && d.message.trim()));
    assert.deepEqual(definition.diagnose(freezeSnapshot(block)), issues);
    assert.deepEqual(block, before);
  }));
  for (const command of brief.commands) {
    const prepare = (state: DocState, args: unknown) => prepareCommand(plugin, command.id, state, actor, args);
    command.invalidArgs.forEach((args, i) => check(`${command.id}: invalid args ${i + 1}`, () => {
      assert.throws(() => prepare(fixture(), args), /Invalid arguments/);
    }));
    for (const kind of ["missing", "deleted", "wrong-type"] as const) check(`${command.id}: ${kind} target declines`, () => {
      let state = kind === "missing" ? emptyDocument("plugin-test-open-document") : fixture(undefined, kind === "wrong-type" ? "unknown.other/v1" : brief.blockType);
      if (kind === "deleted") state = applyTransaction(state, tx([{ op: "delete", block: target }]));
      assert.deepEqual(prepare(state, commandArgs(command.validArgs)), { status: "not-applicable" });
    });
    command.cases.forEach((c, i) => check(`${command.id}: scenario ${i + 1}, core/Yjs/replication/native roundtrip`, () => {
      const state = fixture(c.fields);
      const before = structuredClone(state);
      const result = prepare(state, commandArgs(c.args));
      assert.deepEqual(state, before);
      assert.deepEqual(prepare(state, commandArgs(c.args)), result);
      if (c.expectedFields === null) {
        assert.deepEqual(result, { status: "not-applicable" });
        return;
      }
      assert.equal(result.status, "ready");
      if (result.status !== "ready") throw new Error("Expected ready result");
      // This first archetype only edits fields on the targeted block.
      assert.ok(result.ops.length > 0);
      for (const op of result.ops) assert.ok(op.op === "setField" && op.block === target, "text-block v0 supports target setField operations only");
      const transaction = tx(result.ops);
      const next = applyTransaction(state, transaction);
      assert.deepEqual(next.blocks[target]!.fields, { ...c.expectedFields, futureField: { preserved: true } });
      for (const key of ["text", "children", "type", "id"] as const) assert.deepEqual(next.blocks[target]![key], state.blocks[target]![key]);
      assert.deepEqual(next.blocks["fixture-child"], state.blocks["fixture-child"]);
      const a = newDocument(state.docId), b = newDocument(state.docId);
      try {
        for (const setup of state.log) applyY(a, setup);
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        // Concurrent ordinary text edit from a peer with no plugin installed.
        applyY(b, tx([{ op: "textEdit", block: target, changes: [{ retain: 4 }, { insert: "!" }] }]));
        applyY(a, transaction);
        assert.equal(canonicalJson(readState(a)), canonicalJson(next));
        const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b);
        Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
        assert.equal(canonicalJson(readState(a)), canonicalJson(readState(b)));
        assert.deepEqual(readState(a).blocks[target]!.fields, next.blocks[target]!.fields);
        assert.equal(readState(a).blocks[target]!.text!.s, "A😀B!");
        assert.deepEqual(JSON.parse(canonicalJson(readState(a))), readState(a));
        preview = readState(a).blocks[target];
      } finally { a.destroy(); b.destroy(); }
    }));
  }
  return { checks, preview };
}
