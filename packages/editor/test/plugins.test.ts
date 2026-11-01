import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, createActorKey, createSecuredDocument, makeBlock, rootDigest, toBase64, type Access, type Op } from "@nooq/core";
import { defineBlock, defineCommand, defineJob, definePlugin, PluginRegistry, type JobContext, type Plugin } from "@nooq/plugins";
import { defineDOMPlugin, type BlockViewContext } from "@nooq/plugins/dom";
import { essentials, insertBlock, splitBlock } from "@nooq/plugins/essentials";
import { callout, callouts, cycleTone, insertCallout } from "@nooq/plugin-callouts";
// Retain v1 textarea coverage; rich editing has its own integration/browser suite.
import { calloutsPlainDOM as calloutsDOM } from "@nooq/plugin-callouts/dom";
import { admitEnvelope, applyCaptured, newDocument, sealEnvelope } from "@nooq/yjs";
import { settled } from "@nooq/sync";
import { Editor, type EditorOptions } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM, rewritePlugin, review } from "../src/reference.ts";

const human = { actorId: "human:writer", kind: "human" as const };
const editor = (options: Partial<EditorOptions> = {}) => new Editor({ docId: "plugin-tests", actor: human, plugins: [essentials, callouts], ...options });
const insert = (e: Editor, type = callout.type, parent: string | null = null) => {
  const result = e.commands.run(insertBlock, { type, parent });
  if (result.status !== "applied") throw new Error(`Insert failed: ${result.status}`);
  return result.selection!.block;
};
const plugin = (id: string, extras: Partial<Plugin> = {}) => definePlugin({ id, version: "1.0.0", apiVersion: 1, contributes: {}, ...extras });
const area = (surface: ReturnType<typeof createSurface>, id: string) => surface.element.querySelector<HTMLTextAreaElement>(`[data-nq-block="${id}"] textarea`)!;

test("registry validates versions, dependency cycles and explicit contribution owners", () => {
  expect(() => new PluginRegistry([plugin("a"), plugin("a")])).toThrow("Duplicate");
  expect(() => new PluginRegistry([plugin("a", { requires: { b: "^1.0.0" } })])).toThrow("requires");
  expect(() => new PluginRegistry([plugin("a", { requires: { b: "^2.0.0" } }), plugin("b")])).toThrow("requires");
  expect(() => new PluginRegistry([plugin("a", { requires: { b: "*" } }), plugin("b", { requires: { a: "*" } })])).toThrow("cycle");
  expect(() => new PluginRegistry([plugin("bad", { apiVersion: 2 as 1 })])).toThrow("API");
  const replacement = plugin("override", { contributes: { commands: [cycleTone] } });
  expect(() => new PluginRegistry([callouts, replacement])).toThrow("Conflicting");
  expect(new PluginRegistry([callouts, replacement], { [`command:${cycleTone.id}`]: "override" }).command(cycleTone.id)!.plugin).toBe("override");
  expect(() => new PluginRegistry([callouts], { "command:missing": "nooq.callouts" })).toThrow("Invalid resolution");
});

test("commands prepare immutable state, preview without effects, and commit one atomic batch", () => {
  const e = editor(), before = canonicalJson(e.view);
  const preview = e.commands.preview(insertBlock, { type: callout.type, parent: null });
  expect(preview.status).toBe("ready"); expect(canonicalJson(e.view)).toBe(before);
  const id = insert(e); e.editText(id, "hello world");
  const logs = e.history().length;
  const split = e.commands.run(splitBlock, { block: id, anchor: 5, head: 6 });
  expect(split.status).toBe("applied"); expect(e.history()).toHaveLength(logs + 1);
  expect(e.view.blocks[id]!.text!.s).toBe("hello");
  expect(e.view.blocks[e.view.roots[1]!]!.text!.s).toBe("world");
  expect(e.history().at(-1)!.actor.plugin).toBe("nooq.essentials");
  expect(e.commands.run(cycleTone, {} as any).status).toBe("failed");
  const state = canonicalJson(e.view);
  expect(e.commands.run("missing", {}).status).toBe("failed"); expect(canonicalJson(e.view)).toBe(state);
  e.close();
});

test("invalid batches, empty batches, async preparation and nested dispatch leave no effects", () => {
  let e: Editor;
  const args = (x: unknown): x is null => x === null;
  const invalid = defineCommand({ id: "invalid", label: "Invalid", validateArgs: args, prepare(ctx) {
    const block = ctx.createBlock(callout.type);
    return { status: "ready", intent: "invalid", ops: [{ op: "insert", block, parent: null }, { op: "delete", block: "missing" }] };
  } });
  const empty = defineCommand({ id: "empty", label: "Empty", validateArgs: args, prepare: () => ({ status: "ready", intent: "empty", ops: [] }) });
  const nested = defineCommand({ id: "nested", label: "Nested", validateArgs: args, prepare() { expect(e.commands.run(empty, null).status).toBe("failed"); return { status: "not-applicable" }; } });
  const asyncCommand = { ...empty, id: "async", prepare: async () => ({ status: "ready", intent: "async", ops: [] }) } as any;
  e = editor({ plugins: [callouts, plugin("commands", { contributes: { commands: [invalid, empty, nested, asyncCommand] } })] });
  const before = canonicalJson(e.view);
  expect(e.commands.run(invalid, null).status).toBe("failed");
  expect(e.commands.run(empty, null).status).toBe("not-applicable");
  expect(e.commands.run(nested, null).status).toBe("not-applicable");
  expect(e.commands.run(asyncCommand, null).status).toBe("failed");
  expect(canonicalJson(e.view)).toBe(before); e.close();
});

test("scope setup is ordered, rolls back on failure, and state is per editor", async () => {
  const events: string[] = [], stores: Map<unknown, unknown>[] = [];
  const base = plugin("base", { setup(ctx) { events.push("base"); stores.push(ctx.state); ctx.onCleanup(() => events.push("dispose-base")); } });
  const child = plugin("child", { requires: { base: "^1.0.0" }, setup(ctx) { events.push("child"); ctx.onCleanup(() => events.push("dispose-child")); throw new Error("setup fails"); } });
  expect(() => editor({ plugins: [child, base] })).toThrow("setup fails");
  expect(events).toEqual(["base", "child", "dispose-child", "dispose-base"]);
  const a = editor({ plugins: [base] }), b = editor({ plugins: [base] });
  expect(stores[1]).not.toBe(stores[2]);
  a.close(); a.close(); b.close();
  expect(events.filter(x => x === "dispose-base")).toHaveLength(3);
});

test("diagnostics are on demand and observers cannot dispatch repair loops", async () => {
  let calls = 0, observed = 0, e: Editor;
  const checked = defineBlock({ ...callout, diagnose: () => { calls++; return []; } });
  const watch = plugin("watch", { contributes: { blocks: [checked] }, setup(ctx) {
    ctx.onChange(() => { observed++; throw new Error("observer failure"); });
    ctx.onChange(() => { expect(e.commands.run(insertBlock, { type: callout.type, parent: null }).status).toBe("failed"); });
  } });
  e = editor({ plugins: [essentials, watch] });
  const a = insert(e), b = insert(e); await settled(); expect(calls).toBe(0);
  e.diagnose(a); e.diagnose(a); expect(calls).toBe(1);
  e.editText(b, "unrelated"); await settled(); e.diagnose(a); expect(calls).toBe(1);
  e.editText(a, "changed"); await settled(); e.diagnose(a); expect(calls).toBe(2);
  expect(observed).toBeGreaterThan(0); expect(e.view.roots).toHaveLength(2); expect(e.errors.some(e => e.phase === "observer")).toBe(true); e.close();
});

test("public callout inserts, edits, moves, syncs, and restores with a missing-plugin peer", async () => {
  const a = editor(), b = editor({ plugins: [] });
  const custom = createSurface(a, { plugins: [calloutsDOM, essentialsDOM] }), fallback = createSurface(b);
  document.body.append(custom.element, fallback.element);
  const id = insert(a), child = insert(a, "nooq.paragraph/v1", id);
  a.editText(id, "callout"); a.editText(child, "child"); a.setField(id, "future", { keep: true });
  a.commands.run(cycleTone, { block: id });
  await settled(); const text = area(custom, id); text.focus(); text.setSelectionRange(3, 3);
  const container = insert(a, "nooq.paragraph/v1"); a.moveBlock(id, container); await settled();
  expect(area(custom, id)).toBe(text); expect(text.selectionStart).toBe(3);
  a.deleteBlock(id); a.restoreBlock(id, null); Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc)); await settled();
  expect(await rootDigest(a.view)).toBe(await rootDigest(b.view));
  expect(canonicalJson(a.view)).toBe(canonicalJson(b.view));
  expect(fallback.element.textContent).toContain("nooq.callout/v1");
  expect(area(fallback, id).value).toBe("callout"); expect(area(fallback, child).value).toBe("child");
  a.close(); b.close(); expect(custom.element.isConnected).toBe(false);
});

test("callout menu inserts beside its nested source in one transaction and respects changed text", async () => {
  const e = editor(), parent = insert(e), source = insert(e, "nooq.paragraph/v1", parent);
  const surface = createSurface(e, { plugins: [calloutsDOM, essentialsDOM] }); document.body.append(surface.element);
  await settled(); const text = area(surface, source); text.focus(); text.value = "/"; text.dispatchEvent(new Event("input"));
  const before = e.history().length;
  const menu = Array.from(surface.element.querySelectorAll<HTMLElement>("[role=option]")).find(option => option.textContent?.includes("insert-callout"))!;
  menu.click(); await settled();
  const children = e.view.blocks[parent]!.children;
  expect(children).toHaveLength(2); expect(e.view.blocks[children[1]!]!.type).toBe(callout.type);
  expect(e.view.blocks[source]!.text!.s).toBe(""); expect(e.history()).toHaveLength(before + 1);
  expect(document.activeElement).toBe(area(surface, children[1]!));
  e.editText(source, "/changed remotely");
  expect(e.commands.run(insertCallout, { parent, clearBlock: source }).status).toBe("not-applicable");
  expect(e.view.blocks[source]!.text!.s).toBe("/changed remotely"); e.close();
});

test("a text command override declining an edit also restores the visible text", async () => {
  const declined = defineCommand({ id: "nooq.text.edit", label: "Locked", validateArgs: (a): a is unknown => true, prepare: () => ({ status: "not-applicable" }) });
  const e = editor({ plugins: [essentials, callouts, plugin("locked", { contributes: { commands: [declined] } })], resolve: { "command:nooq.text.edit": "locked" } });
  const id = insert(e); e.editText(id, "kept");
  const surface = createSurface(e, { plugins: [calloutsDOM] }); document.body.append(surface.element); await settled();
  const text = area(surface, id); text.value = "discarded"; text.dispatchEvent(new Event("input")); await settled();
  expect(text.value).toBe("kept"); expect(e.view.blocks[id]!.text!.s).toBe("kept"); e.close();
});

test("explicit view replacement, failure containment, and exact disposal", async () => {
  let destroyed = 0;
  const replacement = defineDOMPlugin({ id: "custom", forPlugin: callouts, views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("section"), text = ctx.mountText(); element.append(text.element, ctx.children.element);
    return { element, update() { throw new Error("broken view"); }, destroy() { destroyed++; } };
  } }] });
  const e = editor(); insert(e);
  expect(() => createSurface(e, { plugins: [calloutsDOM, replacement] })).toThrow("Conflicting");
  const s = createSurface(e, { plugins: [calloutsDOM, replacement], resolve: { [`view:${callout.type}`]: "custom" } });
  await settled(); expect(s.element.querySelector(".nq-fallback")).not.toBeNull(); expect(destroyed).toBe(1);
  s.destroy(); s.destroy(); e.close(); expect(destroyed).toBe(1);
});

test("composition survives a remote insertion and uses the same textarea", async () => {
  const e = editor(), id = insert(e); e.editText(id, "abc");
  const surface = createSurface(e, { plugins: [calloutsDOM] }); document.body.append(surface.element); await settled();
  const text = area(surface, id); text.focus(); text.dispatchEvent(new Event("compositionstart")); text.value = "abあc";
  e.applyTextChanges(id, [{ insert: "++" }]); await settled(); expect(text.value).toBe("abあc");
  text.dispatchEvent(new Event("compositionend")); await settled();
  expect(e.view.blocks[id]!.text!.s).toBe("++abあc"); expect(area(surface, id)).toBe(text); e.close();
});

test("writing views update author attribution without replacing the text controller", async () => {
  const e = editor(), id = insert(e, "nooq.paragraph/v1"), s = createSurface(e, { plugins: [essentialsDOM] }); await settled();
  const text = area(s, id);
  e.apply({ id: "remote-author", actor: { actorId: "ai:writer", kind: "ai" }, lamport: 20, causality: {}, ops: [{ op: "textEdit", block: id, changes: [{ insert: "Authored by a model" }] }] });
  await settled();
  expect(s.element.querySelector(`[data-nq-block="${id}"] [data-actor="ai"]`)).not.toBeNull();
  expect(s.element.querySelector(`[aria-label="Written by ai:writer"]`)).not.toBeNull();
  expect(area(s, id)).toBe(text); e.close();
});

test("disposed views cannot dispatch, including after recovery to a fallback", async () => {
  let context!: BlockViewContext;
  const broken = defineDOMPlugin({ id: "broken", forPlugin: callouts, views: [{ type: callout.type, mount(ctx) {
    context = ctx; return { element: ctx.children.element, update() { throw new Error("recover"); } };
  } }] });
  const e = editor(), id = insert(e), s = createSurface(e, { plugins: [broken] }); await settled();
  expect(context.signal.aborted).toBe(true);
  expect(context.run(cycleTone, { block: id }).status).toBe("failed");
  expect(e.view.blocks[id]!.fields.tone).toBe("info");
  expect(() => context.mountText()).toThrow("disposed"); s.destroy(); e.close();
});

test("disposing a review view cancels acceptance that is still validating", async () => {
  let context!: BlockViewContext;
  const view = defineDOMPlugin({ id: "review-test", forPlugin: review, views: [{ type: "nooq.suggestion/v1", mount(ctx) {
    context = ctx; return { element: ctx.children.element, update() {} };
  } }] });
  const e = editor({ plugins: [essentials, review] }), id = insert(e, "nooq.paragraph/v1");
  e.editText(id, "before");
  await e.propose({ ops: [{ op: "textEdit", block: id, changes: [{ insert: "after " }] }], evidence: [id], actor: { actorId: "ai:review-test", model: "test", name: "Test" } });
  const surface = createSurface(e, { plugins: [view] }); await settled();
  const reviewed = await context.review(), acceptance = context.accept({ reviewed });
  surface.destroy(); await expect(acceptance).rejects.toThrow("cancelled");
  expect(e.view.blocks[id]!.text!.s).toBe("before"); e.close();
});

async function secured(role: "writer" | "reader" | "suggester" = "reader") {
  const owner = await createActorKey(), key = await createActorKey();
  const ownerParty = { actorId: "owner", kind: "human" as const, key: toBase64(owner.publicBytes) };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = { owner: ownerParty, nonce, grants: [{ actorId: human.actorId, key: toBase64(key.publicBytes), kind: "human", role }] };
  const a = editor({ docId, actor: { actorId: "owner" }, key: owner }); await a.initializeAccess(access);
  const b = editor({ docId, key }); await b.ready; Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  return { a, b, key, owner, access, docId };
}

test("secured commands deny readers locally, hold missing genesis, and agree with physical admission", async () => {
  const { a, b, key, owner, docId } = await secured();
  const before = canonicalJson(b.view), result = b.commands.run(insertBlock, { type: callout.type, parent: null });
  expect(result.status).toBe("denied"); expect(canonicalJson(b.view)).toBe(before);
  const empty = editor({ docId, key }); await empty.ready;
  expect(empty.commands.run(insertBlock, { type: callout.type, parent: null })).toMatchObject({ status: "denied", reason: "awaiting-genesis", retryable: true });
  const id = insert(a), tx = a.history().at(-1)!;
  const source = newDocument(docId); Y.applyUpdate(source, Y.encodeStateAsUpdate(b.ydoc));
  // An authorized writer's logical decision and independently inspected update agree.
  const ownerKey = await createActorKey(); // wrong key must fail physical verification
  const captured = applyCaptured(source, tx, ownerKey, "owner")!;
  const envelope = await sealEnvelope(source, tx, captured.update, ownerKey, "owner");
  expect((await admitEnvelope(b.ydoc, envelope, captured.update)).verdict).toBe("deny");
  expect(b.view.blocks[id]).toBeUndefined();
  const honest = await sealEnvelope(source, tx, captured.update, owner, "owner");
  expect((await admitEnvelope(b.ydoc, honest, captured.update)).verdict).toBe("allow");
  expect(canonicalJson(a.view)).toBe(canonicalJson(b.view));
  source.destroy(); empty.close(); a.close(); b.close();
});

test("long-running jobs use their original base and fixed identity; cancellation blocks late publication", async () => {
  let finish!: (text: string) => void;
  const feature = rewritePlugin({ generate: () => new Promise(resolve => { finish = resolve; }) });
  const e = editor({ plugins: [essentials, review, feature.plugin], jobBindings: [{ job: feature.job, actor: { actorId: "model", kind: "ai", model: "local" } }] });
  const id = insert(e, "nooq.paragraph/v1"); e.editText(id, "before");
  const job = e.jobs.start(feature.job, { block: id, actor: "owner" } as any); await Promise.resolve();
  e.editText(id, "changed"); finish("after");
  const result = await job.result; expect(result.status).toBe("published");
  if (result.status === "published") { expect((await e.evaluate(result.suggestion)).status).toBe("stale"); expect((e.view.blocks[result.suggestion]!.fields.proposal as any).actor).toBe("model"); }
  const second = e.jobs.start(feature.job, { block: id }); await Promise.resolve(); second.cancel(); finish("late");
  await expect(second.result).rejects.toThrow("cancelled"); await settled();
  expect(Object.values(e.view.blocks).filter(b => b.type === "nooq.suggestion/v1")).toHaveLength(1); e.close();
});

test("job publication rechecks current grants and signing capability", async () => {
  const { a, access, docId } = await secured("writer");
  const modelKey = await createActorKey(); let finish!: (text: string) => void;
  const feature = rewritePlugin({ generate: () => new Promise(resolve => { finish = resolve; }) });
  const e = editor({ docId, plugins: [essentials, review, feature.plugin], jobBindings: [{ job: feature.job, actor: { actorId: "model", kind: "ai" }, signer: modelKey }] });
  await e.ready; const id = insert(a, "nooq.paragraph/v1"); Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  const first = e.jobs.start(feature.job, { block: id }); await Promise.resolve(); finish("changed");
  expect(await first.result).toMatchObject({ status: "denied", retryable: true });
  const second = e.jobs.start(feature.job, { block: id }); await Promise.resolve();
  a.setAccess({ ...access, grants: [...access.grants, { actorId: "model", kind: "ai", key: toBase64(modelKey.publicBytes), role: "suggester" }] });
  Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(a.ydoc)); finish("changed");
  expect(await second.result).toMatchObject({ status: "published" });
  e.close(); a.close();
});

test("wrong keys, wrong kinds, missing signing capability and mismatched key pairs fail closed", async () => {
  const { a, b, key, docId } = await secured("writer");
  const otherKey = await createActorKey();
  const cases = [editor({ docId }), editor({ docId, key: otherKey }), editor({ docId, key, actor: { ...human, kind: "ai" } })];
  for (const e of cases) {
    await e.ready; Y.applyUpdate(e.ydoc, Y.encodeStateAsUpdate(a.ydoc)); const before = canonicalJson(e.view);
    expect(e.commands.run(insertBlock, { type: callout.type, parent: null }).status).toBe("denied");
    expect(canonicalJson(e.view)).toBe(before); e.close();
  }
  const mismatch = editor({ docId, key: { private: key.private, publicBytes: otherKey.publicBytes } });
  await expect(mismatch.ready).rejects.toThrow("mismatch"); expect(mismatch.isClosed).toBe(true); a.close(); b.close();
});

test("unsupported evidence and completed job contexts cannot publish", async () => {
  let context!: JobContext;
  const job = defineJob<null, unknown>({ id: "unsupported", label: "Unsupported", publishes: true, validateArgs: (x): x is null => x === null, async run(ctx) {
    context = ctx; const base = ctx.capture();
    return ctx.publish(base, { ops: [{ op: "insert", block: ctx.createBlock(callout.type), parent: null }] });
  } });
  const e = editor({ plugins: [callouts, plugin("jobs", { contributes: { jobs: [job] } })], jobBindings: [{ job, actor: { actorId: "model", kind: "ai" } }] });
  expect(await e.jobs.start(job, null).result).toMatchObject({ status: "unsupported-evidence" }); expect(e.history()).toHaveLength(0);
  await expect(context.publish({} as any, { ops: [] })).resolves.toEqual({ status: "cancelled" }); e.close();
});

test("acceptance retries revision races, rejects replacement/force races and local double acceptance", async () => {
  const e = editor(), id = insert(e); e.editText(id, "before");
  const suggest = () => e.propose({ actor: { actorId: "model", name: "Model", model: "local" }, evidence: [id], ops: [{ op: "setField", block: id, key: "tone", value: "warning" }] });
  const suggestion = await suggest(), pending = e.accept(suggestion);
  e.editText(id, "changed during hashing");
  await expect(pending).rejects.toThrow("stale"); expect(e.view.blocks[id]!.fields.tone).toBe("info");
  const reviewed = await e.reviewSuggestion(suggestion), forced = e.accept(suggestion, { force: true, reviewed });
  e.editText(id, "changed again"); await expect(forced).rejects.toThrow("Force approval expired");
  await e.accept(suggestion, { force: true, reviewed: await e.reviewSuggestion(suggestion) });
  await expect(e.accept(suggestion)).rejects.toThrow("settled");
  const replacement = await suggest(), accepting = e.accept(replacement);
  e.setField(replacement, "proposal", { ...(e.view.blocks[replacement]!.fields.proposal as any), context: { changed: true } });
  await expect(accepting).rejects.toThrow("review again"); e.close();
});

test("continuous changes exhaust acceptance's bounded retry without adopting", async () => {
  const e = editor(), id = insert(e);
  const suggestion = await e.propose({ actor: { actorId: "model", name: "Model", model: "local" }, evidence: [id], ops: [{ op: "setField", block: id, key: "tone", value: "warning" }] });
  await settled();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let changes = 0;
  crypto.subtle.digest = ((...args: Parameters<typeof digest>) => { e.setField(id, "concurrent", ++changes); return digest(...args); }) as typeof crypto.subtle.digest;
  try { await expect(e.accept(suggestion)).rejects.toThrow("changed-during-validation"); }
  finally { crypto.subtle.digest = digest; }
  expect(e.history().some(tx => !!tx.adoptedBy)).toBe(false); expect(e.view.blocks[id]!.fields.tone).toBe("info"); e.close();
});

test("an observed remote settlement invalidates pending acceptance", async () => {
  const a = editor(), b = editor(), id = insert(a);
  const suggestion = await a.propose({ actor: { actorId: "model", name: "Model", model: "local" }, evidence: [id], ops: [{ op: "setField", block: id, key: "tone", value: "warning" }] });
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc)); await a.accept(suggestion);
  const pending = b.accept(suggestion); Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  await expect(pending).rejects.toThrow("settled");
  expect(b.history().some(tx => !!tx.adoptedBy)).toBe(false); // b never adopted it a second time
  expect(b.settledBy(suggestion)).toBe(a.actorId); a.close(); b.close();
});
