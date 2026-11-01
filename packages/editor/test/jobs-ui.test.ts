/** The working-state surface (foundation P1): job strips, draft previews, and the onJob registry behind them. */
import "./dom.ts";
import { expect, test } from "bun:test";
import { defineJob, definePlugin, type Plugin } from "@nooq/plugins";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface, type EditorSurface, type SurfaceOptions } from "../src/dom.ts";
import { essentials, essentialsDOM, referenceDOM, referenceJobBindings, referencePlugins, review, reviewDOM, rewritePlugin, simulatedRewrite } from "../src/reference.ts";

const DOC = "jobs-ui-test";
const PARAGRAPH = "nooq.paragraph/v1";

interface Fixture { editor: Editor; surface: EditorSurface }

function mounted(editor: Editor, plugins: NonNullable<SurfaceOptions["plugins"]>): EditorSurface {
  const surface = createSurface(editor, { plugins });
  document.body.append(surface.element);
  return surface;
}

function referenceFixture(extraPlugins: readonly Plugin[] = [], domPlugins = referenceDOM): Fixture {
  const editor = new Editor({ docId: DOC, actor: { actorId: "writer" }, plugins: [...referencePlugins, ...extraPlugins], jobBindings: referenceJobBindings() });
  return { editor, surface: mounted(editor, domPlugins) };
}

/** A rewrite job the test drives by hand: it runs until `finish` is called. */
function manualRewrite(model: string): { plugin: Plugin; finish(text: string): void } {
  let finish!: (text: string) => void;
  const feature = rewritePlugin({ generate: () => new Promise(resolve => { finish = resolve; }) });
  return { plugin: feature.plugin, finish: text => finish(text) };
}

function manualBinding(plugin: Plugin, model: string) {
  const job = plugin.contributes.jobs?.[0];
  if (!job) throw new Error("manual rewrite plugin contributes no job");
  return { job: job.id, actor: { actorId: `ai:${model}`, kind: "ai" as const, model } };
}

function blockRow(fixture: Fixture, id: string): HTMLElement {
  const row = fixture.surface.element.querySelector<HTMLElement>((`[data-nq-block="${id}"]`));
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

async function withText(fixture: Fixture, text: string): Promise<string> {
  const id = fixture.editor.insertBlock({ type: PARAGRAPH, parent: null });
  fixture.editor.editText(id, text);
  await settled();
  return id;
}

test("onJob reports the binding actor, the frozen args and the live handle; unsubscribing stops delivery", async () => {
  const editor = new Editor({ docId: DOC, actor: { actorId: "writer" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  const id = editor.insertBlock({ type: PARAGRAPH, parent: null });
  editor.editText(id, "say something short");
  interface Seen { job: string; label: string; actor: { actorId: string; model?: string } | undefined; args: unknown; handle: unknown }
  const seen: Seen[] = [];
  let explode = false;
  const off = editor.onJob(start => { seen.push(start); });
  editor.onJob(() => { if (explode) throw new Error("listener exploded"); }); // a throwing listener never blocks the next one
  const handle = editor.jobs.start(simulatedRewrite.job, { block: id });
  expect(seen).toHaveLength(1);
  const start = seen[0]!;
  expect(start.job).toBe("nooq.ai.rewrite");
  expect(start.label).toBe("Improve this block");
  expect(start.actor?.actorId).toBe("ai:reference");
  expect(start.actor?.model).toBe("simulated/1");
  expect(Object.isFrozen(start.args)).toBe(true);
  expect(start.args).toEqual({ block: id });
  expect(start.handle).toBe(handle);
  off();
  explode = true;
  const again = editor.jobs.start(simulatedRewrite.job, { block: id });
  expect(seen).toHaveLength(1); // the unsubscribed listener heard nothing; the thrower only reached the error channel
  again.cancel();
  await expect(again.result).rejects.toThrow("cancelled");
  handle.cancel();
  await expect(handle.result).rejects.toThrow("cancelled");
  expect(editor.errors.map(error => String(error.cause))).toContain("Error: listener exploded");
  editor.close();
});

test("a block job mounts the working strip, streams the draft, and settlement removes both", async () => {
  const fixture = referenceFixture();
  const text = "stream this sentence word by word so growth stays observable";
  const id = await withText(fixture, text);
  const row = blockRow(fixture, id);
  const handle = fixture.editor.jobs.start(simulatedRewrite.job, { block: id });
  const strip = row.querySelector<HTMLElement>(".nq-working")!;
  expect(strip.getAttribute("role")).toBe("status");
  expect(strip.textContent).toContain("working");
  expect(strip.querySelector(".nq-working-kind")?.textContent).toBe("AI");
  expect(strip.querySelector(".nq-working-model")?.textContent).toBe("simulated/1");
  const preview = row.querySelector<HTMLElement>(".nq-draft")!;
  expect(preview.getAttribute("aria-hidden")).toBe("true"); // the strip is the screen-reader channel (§9)
  expect((await handle.result).status).toBe("published");
  expect(preview.textContent).toBe(text.charAt(0).toUpperCase() + text.slice(1));
  await settled();
  expect(row.querySelector(".nq-working")).toBeNull();
  expect(row.querySelector(".nq-draft")).toBeNull();
  // The draft was never the proposal: publication arrives through the review flow.
  const card = fixture.surface.element.querySelector<HTMLElement>("article.nq-sugg");
  expect(card).not.toBeNull();
  expect(card!.textContent).toContain("simulated/1");
  fixture.surface.destroy();
  fixture.editor.close();
});

test("Stop cancels the job and removes the strip, the draft and any proposal", async () => {
  const fixture = referenceFixture();
  const id = await withText(fixture, "hold this thought for a while longer please");
  const row = blockRow(fixture, id);
  const handle = fixture.editor.jobs.start(simulatedRewrite.job, { block: id });
  row.querySelector<HTMLElement>(".nq-working")!.querySelector<HTMLButtonElement>("button")!.click();
  await expect(handle.result).rejects.toThrow("cancelled");
  await settled();
  expect(row.querySelector(".nq-working")).toBeNull();
  expect(row.querySelector(".nq-draft")).toBeNull();
  expect(fixture.surface.element.querySelector("article.nq-sugg")).toBeNull();
  expect([...Object.values(fixture.editor.view.blocks)].filter(block => block?.type === "nooq.suggestion/v1")).toHaveLength(0);
  fixture.surface.destroy();
  fixture.editor.close();
});

test("the strip re-attaches across renders and drops silently when its row vanishes", async () => {
  const held = manualRewrite("test/9");
  const editor = new Editor({ docId: DOC, actor: { actorId: "writer" }, plugins: [essentials, review, held.plugin], jobBindings: [manualBinding(held.plugin, "test/9")] });
  const fixture: Fixture = { editor, surface: mounted(editor, [essentialsDOM, reviewDOM]) };
  const id = await withText(fixture, "hold this");
  const job = editor.registry.job("nooq.ai.rewrite")!.definition;
  const handle = editor.jobs.start(job, { block: id });
  const container = blockRow(fixture, id).querySelector<HTMLElement>(".nq-jobs")!;
  expect(container.querySelector(".nq-working")?.textContent).toContain("test/9");
  // A render that keeps the row keeps the strip with its block.
  editor.editText(id, "hold this still");
  await settled();
  expect(container.parentElement).toBe(blockRow(fixture, id));
  // The block's row vanishes: the strip drops silently, the job keeps running.
  editor.deleteBlock(id);
  await settled();
  expect(container.isConnected).toBe(false);
  expect(fixture.surface.element.querySelector(".nq-notice")).toBeNull();
  // The block returns (restore, windowing remount): the strip re-attaches to the fresh row.
  editor.restoreBlock(id, null);
  await settled();
  expect(container.isConnected).toBe(true);
  expect(container.parentElement).toBe(blockRow(fixture, id));
  held.finish("done");
  await handle.result.catch(() => {}); // published or unsupported evidence: either way the job settles
  await settled();
  expect(fixture.surface.element.querySelector(".nq-jobs")).toBeNull();
  fixture.surface.destroy();
  editor.close();
});

test("destroying the surface removes its strips and ignores later jobs", async () => {
  const held = manualRewrite("test/9");
  const editor = new Editor({ docId: DOC, actor: { actorId: "writer" }, plugins: [essentials, review, held.plugin], jobBindings: [manualBinding(held.plugin, "test/9")] });
  const surface = mounted(editor, [essentialsDOM, reviewDOM]);
  const id = editor.insertBlock({ type: PARAGRAPH, parent: null });
  editor.editText(id, "hold");
  await settled();
  const job = editor.registry.job("nooq.ai.rewrite")!.definition;
  editor.jobs.start(job, { block: id }); // held open by its provider
  const container = surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"]`)!.querySelector<HTMLElement>(".nq-jobs")!;
  surface.destroy();
  expect(container.isConnected).toBe(false);
  const later = editor.jobs.start(job, { block: editor.insertBlock({ type: PARAGRAPH, parent: null }) });
  await settled();
  expect(document.body.querySelector(".nq-jobs")).toBeNull(); // no listener remains, and no row renders it
  later.cancel();
  await expect(later.result).rejects.toThrow("cancelled");
  editor.close();
});

test("a job whose args name no block mounts nothing", async () => {
  const echo = defineJob<{ text: string }, string>({
    id: "test.echo", label: "Echo",
    validateArgs: (input): input is { text: string } => !!input && typeof input === "object" && "text" in input && typeof input.text === "string",
    async run(_context, args) { return args.text; },
  });
  const echoPlugin = definePlugin({ id: "test.echo", version: "1.0.0", apiVersion: 1, contributes: { jobs: [echo] } });
  const fixture = referenceFixture([echoPlugin]);
  await withText(fixture, "plain text");
  const handle = fixture.editor.jobs.start(echo, { text: "hi" });
  expect(await handle.result).toBe("hi");
  await settled();
  expect(fixture.surface.element.querySelector(".nq-jobs")).toBeNull();
  expect(fixture.surface.element.querySelector(".nq-working")).toBeNull();
  fixture.surface.destroy();
  fixture.editor.close();
});
