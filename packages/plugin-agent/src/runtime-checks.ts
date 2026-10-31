/** Independent oracle: generated commands dispatch through actual Editors. */
import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { canonicalJson, createActorKey, createSecuredDocument, makeBlock, toBase64, type Access } from "@nooq/core";
import { Editor } from "@nooq/editor";
import { admitEnvelope, sealEnvelope } from "@nooq/yjs";
import type { Plugin } from "@nooq/plugins";
import type { Brief } from "./brief.ts";
import type { Check, Conformance } from "./conformance.ts";

export async function runRuntimeChecks(plugin: Plugin, brief: Brief): Promise<Conformance> {
  const checks: Check[] = [];
  const test = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try { await fn(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: String(e) }); }
  };
  const make = () => new Editor({ docId: "runtime-conformance", actor: { actorId: "human:tester" }, plugins: [plugin] });
  const setup = (e: Editor, fields: object) => {
    const id = e.insertBlock({ type: brief.blockType, parent: null, fields: { ...fields, future: "preserved" }, text: "A😀B" });
    e.insertBlock({ type: "unknown.child/v3", parent: id, text: "child" });
    return id;
  };
  await test("runtime: insertion validates all arguments and rejects missing parents without mutation", () => {
    const command = plugin.contributes.commands!.find(c => c.id === brief.insertCommand!.id)!;
    for (const args of [null, [], {}, {parent: 42}, {parent:null,index:"1"}, {parent:null,index:0.5}, {parent:null,clearBlock:42}]) assert.equal(command.validateArgs(args), false);
    const e = make();
    try {
      const before = canonicalJson(e.view);
      assert.equal(e.commands.run(command.id, {parent:"missing-parent"}).status, "not-applicable");
      assert.equal(canonicalJson(e.view), before);
    } finally { e.close(); }
  });
  await test("runtime: insertion preview, fresh IDs, atomic slash consumption and selection", () => {
    const e = make();
    try {
      const source = setup(e, brief.defaults.fields); e.editText(source, "/");
      const before = canonicalJson(e.view), args = { parent: null, index: 1, clearBlock: source };
      assert.equal(e.commands.preview(brief.insertCommand!.id, args).status, "ready");
      assert.equal(canonicalJson(e.view), before);
      const logs = e.view.log.length, result = e.commands.run(brief.insertCommand!.id, args);
      assert.equal(result.status, "applied"); if (result.status !== "applied") return;
      assert.equal(e.view.log.length, logs + 1);
      assert.equal(result.transaction.actor.plugin, brief.id);
      assert.equal(e.view.blocks[source]!.text!.s, "");
      const id = result.selection!.block; assert.notEqual(id, source);
      assert.equal(e.view.roots[1], id); assert.deepEqual(e.view.blocks[id]!.fields, brief.defaults.fields);
      e.editText(source, "/new remote text"); const unchanged = canonicalJson(e.view);
      assert.equal(e.commands.run(brief.insertCommand!.id, args).status, "not-applicable");
      assert.equal(canonicalJson(e.view), unchanged);
    } finally { e.close(); }
  });
  for (const command of brief.commands) for (const [index, scenario] of command.cases.entries()) {
    await test(`runtime: ${command.id} case ${index + 1}, provenance and missing-plugin peer`, () => {
      const e = make(), peer = new Editor({ docId: e.docId, actor: { actorId: "human:peer" } });
      try {
        const id = setup(e, scenario.fields), before = e.view, logs = before.log.length;
        Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(e.ydoc));
        peer.applyTextChanges(id, [{ insert: "remote " }]);
        const result = e.commands.run(command.id, { ...scenario.args, block: id });
        if (scenario.expectedFields === null) { assert.equal(result.status, "not-applicable"); assert.equal(canonicalJson(e.view), canonicalJson(before)); }
        else {
          assert.equal(result.status, "applied"); if (result.status !== "applied") return;
          assert.equal(e.view.log.length, logs + 1); assert.equal(result.transaction.actor.plugin, brief.id);
          assert.equal(result.transaction.actor.actorId, "human:tester");
          assert.deepEqual(e.view.blocks[id]!.fields, { ...scenario.expectedFields, future: "preserved" });
          assert.deepEqual(e.view.blocks[id]!.children, before.blocks[id]!.children);
          assert.deepEqual(e.view.blocks[id]!.text, before.blocks[id]!.text);
        }
        const a = Y.encodeStateAsUpdate(e.ydoc), b = Y.encodeStateAsUpdate(peer.ydoc);
        Y.applyUpdate(e.ydoc, b); Y.applyUpdate(peer.ydoc, a);
        assert.equal(canonicalJson(e.view), canonicalJson(peer.view));
        assert.equal(e.view.blocks[id]!.text!.s, "remote A😀B");
      } finally { e.close(); peer.close(); }
    });
  }
  await test("runtime: editor isolation and disposed dispatch", () => {
    const a = make(), b = make();
    try {
      const first = a.commands.run(brief.insertCommand!.id, { parent: null });
      assert.equal(first.status, "applied"); assert.equal(b.view.roots.length, 0);
      a.close(); assert.equal(a.commands.run(brief.insertCommand!.id, { parent: null }).status, "failed");
    } finally { a.close(); b.close(); }
  });
  await test("runtime: reader and missing-genesis denial without mutation; signed writer admission", async () => {
    const ownerKey = await createActorKey(), readerKey = await createActorKey();
    const owner = { actorId: "human:owner", kind: "human" as const, key: toBase64(ownerKey.publicBytes) };
    const { docId, nonce } = await createSecuredDocument(owner);
    const access: Access = { owner, nonce, grants: [{ actorId: "human:reader", kind: "human", key: toBase64(readerKey.publicBytes), role: "reader" }] };
    const a = new Editor({ docId, actor: owner, key: ownerKey, plugins: [plugin] });
    const b = new Editor({ docId, actor: { actorId: "human:reader" }, key: readerKey, plugins: [plugin] });
    try {
      await Promise.all([a.ready, b.ready]);
      const empty = canonicalJson(b.view);
      assert.equal(b.commands.run(brief.insertCommand!.id, { parent: null }).status, "denied"); assert.equal(canonicalJson(b.view), empty);
      await a.initializeAccess(access); const id = setup(a, brief.defaults.fields);
      Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
      for (const command of brief.commands) {
        const before = canonicalJson(b.view);
        assert.equal(b.commands.run(command.id, { ...command.validArgs, block: id }).status, "denied");
        assert.equal(canonicalJson(b.view), before);
      }
      const command = brief.commands[0]!; let update: Uint8Array | undefined;
      const observe = (value: Uint8Array) => { update = value; }; a.ydoc.on("update", observe);
      const result = a.commands.run(command.id, { ...command.validArgs, block: id }); a.ydoc.off("update", observe);
      assert.equal(result.status, "applied"); if (result.status !== "applied") return;
      const envelope = await sealEnvelope(a.ydoc, result.transaction, update!, ownerKey, owner.actorId);
      assert.equal((await admitEnvelope(b.ydoc, envelope, update!)).verdict, "allow");
      assert.equal(canonicalJson(a.view), canonicalJson(b.view));
    } finally { a.close(); b.close(); }
  });
  return { checks };
}
