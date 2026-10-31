import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scaffold, type Brief } from "./brief.ts";

export const repo = resolve(import.meta.dir, "../../..");
export const candidatePaths = ["src/index.ts", "src/dom.ts", "src/plugin.stories.ts"] as const;
export type CandidatePath = typeof candidatePaths[number];
export type Sources = Record<CandidatePath, string>;
export const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export const hashes = (sources: Sources) => Object.fromEntries(candidatePaths.map(path => [path, hash(sources[path])]));
export const packageHash = (sources: Sources) => hash(JSON.stringify(hashes(sources)));
export async function readSources(dir: string): Promise<Sources> {
  return Object.fromEntries(await Promise.all(candidatePaths.map(async p => [p, await readFile(join(dir, p), "utf8")]))) as Sources;
}
export function scaffoldPackage(brief: Brief): Sources {
  return {
    "src/index.ts": scaffold(brief).replace("const block =", "export const block ="),
    "src/dom.ts": `import { defineDOMPlugin } from "@nooq/plugins/dom";
import plugin from "./index.ts";
// Add a menu invoking the insertion command and one view using ctx.mountText.
export default defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [] });\n`,
    "src/plugin.stories.ts": `import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/plugin-agent/storybook";
import plugin from "./index.ts";
import dom from "./dom.ts";
const meta = {
  title: "Plugins/${brief.id}",
  render: (args) => mountPluginStory(plugin, dom, args),
  beforeEach: () => () => disposePluginStories(),
  args: { text: "A useful note", fields: ${JSON.stringify(brief.defaults.fields)} },
} satisfies Meta<PluginStoryArgs>;
export default meta;
type Story = StoryObj<PluginStoryArgs>;
// Implement every story named in the brief, with meaningful awaited play assertions.
export const Default: Story = { play: async ({ canvas, userEvent }) => {
  const text = canvas.getByRole("textbox", { name: ${JSON.stringify(brief.view?.textLabel)} });
  await expect(text).toHaveValue("A useful note");
  await userEvent.clear(text);
  await userEvent.type(text, "Edited in Storybook");
  await expect(text).toHaveValue("Edited in Storybook");
} };\n`,
  };
}

/** Fingerprints executable contracts, not just the two files shown in the prompt. */
export async function contractFingerprint(): Promise<string> {
  const paths: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(join(repo, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path); else if (path.endsWith(".ts")) paths.push(path);
    }
  }
  for (const dir of ["packages/core/src", "packages/yjs/src", "packages/plugins/src", "packages/design/src", "packages/plugin-agent/src"]) await walk(dir);
  paths.push("packages/editor/src/controller.ts", "packages/editor/src/dom.ts", "packages/plugin-agent/package.json", "bun.lock");
  return hash(JSON.stringify(await Promise.all(paths.sort().map(async p => [p, hash(await readFile(join(repo, p), "utf8"))]))));
}

export async function contextSections(): Promise<Record<string, string>> {
  const read = (p: string) => readFile(join(repo, p), "utf8");
  return {
    overview: `Generate a complete developer-bundled inline-text block plugin. Edit only src/index.ts, src/dom.ts and src/plugin.stories.ts. Default exports: Plugin, DOMPlugin, and CSF metadata respectively. Commands include the target-field commands AND the insertion command in the brief. Insertion args: {parent:string|null,index?:number,clearBlock?:string}; create through ctx.createBlock, optionally consume exactly '/' in clearBlock, then insert and request selection. If clearBlock changed, decline without mutation. No implicit dependencies or extra contributions. The manifest is harness-owned. No jobs, export formats or new core APIs in this recipe.`,
    headless: await read("packages/plugins/src/definitions.ts") + "\n" + await read("packages/core/src/model.ts") + "\n" + (await read("packages/core/src/text.ts")).split("export class TextChangeError")[0] + `\nInsertion pattern for an unrelated example.note/v1: const created = ctx.createBlock("example.note/v1"); return {status:"ready", ops:[{op:"insert",block:created,parent:args.parent,index:args.index}], selection:{block:created.id,anchor:0,head:0}}. To consume exactly '/', prepend {op:"textEdit",block:args.clearBlock,changes:[{delete:1}]} after verifying that block is alive and its text is exactly '/'. TextChange uses retain/insert/delete steps, never start/end/inserted offsets. Validate optional index as an integer and optional clearBlock as a string. Decline a missing/deleted parent. Do not use any/as never casts to hide mismatched operation shapes.`,
    dom: await read("packages/plugins/src/dom.ts") + `\nUse document.createElement inside mount only. ctx.mountText({label}) supplies the textarea and handles synchronization/composition. Retain ctx.children.element. update(block) updates field display without replacing the text binding. Keep each native button's visible text equal to its accessible action label; show changing field values in a separate text element. Add accessible native buttons invoking ctx.run(commandId,{block:ctx.block}). Use ctx.signal to scope event listeners; destroy cleans other resources. Show the brief's view.field value visibly, including invalid values. Menu args find the source parent in snapshot, choose the next sibling index and pass clearBlock:ctx.block. Avoid innerHTML. No network, storage, globals or timers.`,
    stories: await read("packages/plugin-agent/src/storybook.ts") + `\nUse standard CSF3 Meta<PluginStoryArgs>/StoryObj<PluginStoryArgs> from @storybook/html-vite (type-only), expect from storybook/test, and the supplied mountPluginStory helper. Export ALL named stories from brief.view.stories. Each requires a play function with awaited assertions using canvas role/label queries. Get userEvent from the play context: play: async ({canvas,userEvent}) => {...}. Default MUST edit the textbox with userEvent.clear/type and assert the resulting value, as in the scaffold. KeyboardCycle must focus the native button (button.focus() or awaited tab), activate with await userEvent.keyboard("{Enter}") and assert the visible changed field. Initial focus is not guaranteed. NestedContent uses args.children:true and asserts canvas.getByRole("textbox",{name:"Text block"}) with toHaveValue("Nested child"), since textarea values are not text nodes. InvalidTone uses an invalid stored field, clicks the button and checks that the invalid value remains. Cover default, alternate field states and text editing. beforeEach must return disposePluginStories as cleanup. Never disable a11y or test checks, catch failed assertions, use fixture IDs, import the editor directly, or change the oracle. These stories run with Storybook's composition/run lifecycle in Chromium, in light and dark themes, followed by an independent axe audit.`,
  };
}
