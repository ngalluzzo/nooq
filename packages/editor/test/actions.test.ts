import "./dom.ts";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, createActorKey, createSecuredDocument, toBase64 } from "@nooq/core";
import { defineCommand, defineJob, definePlugin } from "@nooq/plugins";
import { defineAction, defineDOMPlugin, type Action, type BlockViewContext } from "@nooq/plugins/dom";
import { callout, callouts, cycleTone, insertCallout } from "@nooq/plugin-callouts";
import { calloutsPlainDOM, cycleToneAction } from "@nooq/plugin-callouts/dom";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const make = () => new Editor({ docId: "actions", actor: { actorId: "writer" }, plugins: [callouts] });
function insert(e: Editor) {
  const result = e.commands.run(insertCallout, { parent: null });
  if (result.status !== "applied") throw new Error(result.status);
  return result.selection!.block;
}
const press = (element: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }); element.dispatchEvent(event); return event;
};

test("Callouts shares toolbar and shortcut execution and exposes discoverable state", async () => {
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [calloutsPlainDOM] });
  document.body.append(s.element); await settled();
  const button = s.element.querySelector<HTMLButtonElement>("button")!, text = s.element.querySelector("textarea")!;
  const before = e.history().length;
  expect(s.actions.list(id, "toolbar")).toMatchObject([{ id: cycleToneAction.id, availability: { status: "enabled" } }]);
  expect(e.history()).toHaveLength(before);
  button.click(); await settled(); expect(e.view.blocks[id]!.fields.tone).toBe("warning");
  expect(s.element.querySelector("button")).toBe(button);
  expect(press(text, "Y", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(e.view.blocks[id]!.fields.tone).toBe("success");
  expect(e.history()).toHaveLength(before + 2); expect(e.history().at(-1)!.actor.plugin).toBe(callouts.id);
  e.close();
});

test("availability refreshes, and clicks recheck state before the next render", async () => {
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [calloutsPlainDOM] });
  document.body.append(s.element); await settled();
  const button = s.element.querySelector<HTMLButtonElement>("button")!, text = s.element.querySelector("textarea")!;
  e.setField(id, "tone", { future: true }); e.setField(id, "extra", "keep");
  const before = canonicalJson(e.view); button.click();
  expect(canonicalJson(e.view)).toBe(before);
  expect(press(text, "Y", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  await settled(); expect(button.disabled).toBe(true);
  expect(s.element.textContent).toContain("Choose a supported tone");
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain("Choose a supported tone");
  e.setField(id, "tone", "info"); await settled(); expect(button.disabled).toBe(false);
  e.deleteBlock(id); const deleted = canonicalJson(e.view); button.click();
  expect(canonicalJson(e.view)).toBe(deleted);
  expect(s.actions.run(cycleToneAction.id, id).status).toBe("unavailable");
  e.close();
});

test("listing never prepares commands; execution reads fresh arguments and selection", async () => {
  let prepares = 0, seen: unknown;
  const command = defineCommand<{ block: string; value: unknown }>({ id: "inspect", label: "Inspect", validateArgs: (a): a is any => true,
    prepare(ctx, args) { prepares++; seen = { args, selection: ctx.selection }; return { status: "not-applicable" }; },
  });
  const feature = definePlugin({ id: "inspect", version: "1.0.0", apiVersion: 1, contributes: { commands: [command] } });
  const action = defineAction({ id: "inspect", label: "Inspect", command, args: ctx => ({ block: ctx.block, value: ctx.snapshot.blocks[ctx.block]!.fields.tone }) });
  const e = new Editor({ docId: "actions", actor: { actorId: "writer" }, plugins: [callouts, feature] }), id = insert(e);
  const s = createSurface(e, { plugins: [calloutsPlainDOM, defineDOMPlugin({ id: "inspect", forPlugin: feature, views: [], actions: [action] })] });
  document.body.append(s.element); e.editText(id, "hello"); await settled();
  const area = s.element.querySelector("textarea")!; area.focus(); area.setSelectionRange(1, 4);
  s.actions.list(id); s.actions.list(id); expect(prepares).toBe(0);
  e.setField(id, "tone", "success"); s.actions.run(action.id, id);
  expect(seen).toEqual({ args: { block: id, value: "success" }, selection: { block: id, anchor: 1, head: 4 } });
  expect(prepares).toBe(1); e.close();
});

test("slash menus share availability and refresh open items after state changes", async () => {
  const action = defineAction({ id: "slash-tone", label: "Cycle tone", command: cycleTone, args: ctx => ({ block: ctx.block }),
    placements: ["slash"], enabled: ctx => ctx.snapshot.blocks[ctx.block]!.fields.tone === "info" || "Requires info tone", });
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [defineDOMPlugin({ id: "slash", forPlugin: callouts, views: [], actions: [action] })] });
  document.body.append(s.element); await settled();
  const area = s.element.querySelector("textarea")!; area.value = "/"; area.dispatchEvent(new Event("input"));
  const old = s.element.querySelector<HTMLElement>('[role="option"]')!;
  e.setField(id, "tone", "warning"); const before = e.revision; old.click(); expect(e.revision).toBe(before);
  // Reopen, then prove a remote/local change refreshes the currently displayed menu.
  area.dispatchEvent(new Event("input")); await settled();
  expect(s.element.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
  e.setField(id, "tone", "info"); await settled();
  expect(s.element.querySelector('[role="option"]')?.getAttribute("aria-disabled")).not.toBe("true");
  s.element.querySelector<HTMLElement>('[role="option"]')!.click(); expect(e.view.blocks[id]!.fields.tone).toBe("warning"); e.close();
});

test("toolbar availability follows selection without a document edit and uses roving focus", async () => {
  const first = defineAction({ id: "selected", label: "Selected", command: cycleTone, args: ctx => ({ block: ctx.block }), placements: ["toolbar"],
    enabled: ctx => ctx.selection.anchor !== ctx.selection.head || "Select text first", });
  const second = defineAction({ id: "second", label: "Second", command: cycleTone, args: ctx => ({ block: ctx.block }), placements: ["toolbar"] });
  const e = make(), id = insert(e); e.editText(id, "hello");
  const dom = defineDOMPlugin({ id: "selection", forPlugin: callouts, actions: [first, second], views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("div"); element.append(ctx.mountActionToolbar().element, ctx.mountText().element, ctx.children.element); return { element, update() {} };
  } }] });
  const s = createSurface(e, { plugins: [dom] }); document.body.append(s.element); await settled();
  const [a, b] = Array.from(s.element.querySelectorAll("button")), area = s.element.querySelector("textarea")!;
  expect(a!.disabled).toBe(true); area.focus(); area.setSelectionRange(1, 3); area.dispatchEvent(new Event("select", { bubbles: true }));
  const revision = e.revision; await settled(); expect(a!.disabled).toBe(false); expect(e.revision).toBe(revision);
  a!.focus(); press(a!, "ArrowRight"); expect(document.activeElement).toBe(b); expect(b!.tabIndex).toBe(0); expect(a!.tabIndex).toBe(-1);
  press(b!, "Home"); expect(document.activeElement).toBe(a); e.close();
});

test("hidden, throwing and asynchronous predicates fail closed without running argument builders", async () => {
  let args = 0;
  const base = { label: "Guarded", command: cycleTone, args: (ctx: { block: string }) => { args++; return { block: ctx.block }; }, placements: ["slash", "toolbar"] as const };
  const hidden = defineAction({ ...base, id: "hidden", when: () => false });
  const broken = defineAction({ ...base, id: "broken", enabled() { throw new Error("broken predicate"); } });
  const asyncGuard = defineAction({ ...base, id: "async", when: (async () => true) as any });
  const missingResult = defineAction({ ...base, id: "missing-result", enabled: (() => undefined) as any });
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [defineDOMPlugin({ id: "guarded", forPlugin: callouts, views: [], actions: [hidden, broken, asyncGuard, missingResult] })] });
  await settled();
  expect(s.actions.list(id).map(s => s.availability.status)).toEqual(["hidden", "disabled", "disabled", "disabled"]);
  expect(s.actions.run(hidden.id, id).status).toBe("unavailable");
  expect(s.actions.run(broken.id, id).status).toBe("failed"); expect(s.actions.run(asyncGuard.id, id).status).toBe("failed");
  expect(s.actions.run(missingResult.id, id).status).toBe("failed");
  expect(args).toBe(0); expect(e.view.blocks[id]!.fields.tone).toBe("info");
  expect(e.errors.some(error => String(error.cause).includes("broken predicate"))).toBe(true); e.close();
});

test("shared actions reject ID collisions and require explicit shortcut precedence", async () => {
  const a = defineAction({ id: "a", label: "A", command: cycleTone, args: ctx => ({ block: ctx.block }), keys: ["F8"], when: () => false });
  const b = defineAction({ id: "b", label: "B", command: cycleTone, args: ctx => ({ block: ctx.block }), keys: ["F8"] });
  const dom = (actions: readonly Action[]) => defineDOMPlugin({ id: "actions", forPlugin: callouts, views: [], actions });
  const e = make(), id = insert(e);
  expect(() => createSurface(e, { plugins: [dom([a, b])] })).toThrow("keyOrder");
  expect(() => createSurface(e, { plugins: [dom([a]), defineDOMPlugin({ id: "other", forPlugin: callouts, views: [], actions: [a] })] })).toThrow("Duplicate action");
  expect(() => createSurface(e, { plugins: [dom([a]), defineDOMPlugin({ id: "legacy", forPlugin: callouts, views: [], menus: [a] })] })).toThrow("Duplicate action");
  const s = createSurface(e, { plugins: [dom([a, b])], keyOrder: { F8: ["a", "b"] } }); await settled();
  press(s.element.querySelector("textarea")!, "F8"); expect(e.view.blocks[id]!.fields.tone).toBe("warning"); e.close();
});

test("toolbar failure copy names the action and the remedy, and the cause still reaches the host", async () => {
  const action = defineAction({ id: "explode", label: "Explode", command: cycleTone, placements: ["toolbar"],
    args: () => { throw new Error("argument explosion"); } });
  const dom = defineDOMPlugin({ id: "explode", forPlugin: callouts, actions: [action], views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("div"); element.append(ctx.mountActionToolbar().element, ctx.children.element); return { element, update() {} };
  } }] });
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [dom] });
  document.body.append(s.element); await settled();
  const button = s.element.querySelector<HTMLButtonElement>("button")!;
  button.click();
  expect(button.closest(".nq-action-toolbar")!.querySelector('[role="status"]')?.textContent).toBe("Explode failed. Try again.");
  expect(e.errors.some(error => String(error.cause).includes("argument explosion"))).toBe(true);
  e.close();
});

test("disposed views and surfaces retain no actionable toolbar or bound action scope", async () => {
  let ctx!: BlockViewContext;
  const view = defineDOMPlugin({ id: "lifecycle", forPlugin: callouts, actions: [cycleToneAction], views: [{ type: callout.type, mount(context) {
    ctx = context; const toolbar = ctx.mountActionToolbar(), element = document.createElement("div"); element.append(toolbar.element, ctx.children.element); return { element, update() {} };
  } }] });
  const e = make(), id = insert(e), s = createSurface(e, { plugins: [view] }); await settled();
  const button = s.element.querySelector<HTMLButtonElement>("button")!;
  e.deleteBlock(id); await settled(); e.restoreBlock(id, null);
  expect(ctx.actions.run(cycleToneAction.id).status).toBe("unavailable");
  button.click(); expect(e.view.blocks[id]!.fields.tone).toBe("info");
  s.destroy(); expect(s.actions.run(cycleToneAction.id, id).status).toBe("unavailable"); e.close();
});

test("enabled presentation does not bypass secured command authorization", async () => {
  const owner = await createActorKey(), reader = await createActorKey();
  const party = { actorId: "owner", kind: "human" as const, key: toBase64(owner.publicBytes) };
  const { docId, nonce } = await createSecuredDocument(party);
  const a = new Editor({ docId, actor: { actorId: "owner" }, key: owner, plugins: [callouts] });
  await a.initializeAccess({ owner: party, nonce, grants: [{ actorId: "reader", kind: "human", role: "reader", key: toBase64(reader.publicBytes) }] });
  const id = insert(a);
  const b = new Editor({ docId, actor: { actorId: "reader" }, key: reader, plugins: [callouts] }); await b.ready;
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  const s = createSurface(b, { plugins: [calloutsPlainDOM] }); await settled(); const before = canonicalJson(b.view);
  expect(s.actions.list(id, "toolbar")[0]!.availability.status).toBe("enabled");
  expect(s.actions.run(cycleToneAction.id, id).status).toBe("denied"); expect(canonicalJson(b.view)).toBe(before);
  s.element.querySelector<HTMLButtonElement>("button")!.click(); expect(s.element.querySelector('[role="status"]')?.textContent).not.toBe("");
  a.close(); b.close();
});

test("job actions return a cancellable host-owned handle and preserve the input at invocation", async () => {
  let finish!: () => void;
  const job = defineJob<{ block: string }, string>({ id: "job", label: "Job", validateArgs: (a): a is any => true,
    async run(_ctx, args) { await new Promise<void>(resolve => { finish = resolve; }); return args.block; },
  });
  const feature = definePlugin({ id: "job", version: "1.0.0", apiVersion: 1, contributes: { jobs: [job] } });
  const action = defineAction({ id: "job", label: "Job", job, args: ctx => ({ block: ctx.block }) });
  const e = new Editor({ docId: "jobs", actor: { actorId: "writer" }, plugins: [callouts, feature] }), id = insert(e);
  const s = createSurface(e, { plugins: [defineDOMPlugin({ id: "job", forPlugin: feature, views: [], actions: [action] })] }); await settled();
  const result = s.actions.run(action.id, id); expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error(result.status);
  await Promise.resolve(); result.job.cancel(); finish(); await expect(result.job.result).rejects.toThrow("cancelled"); e.close();
});
