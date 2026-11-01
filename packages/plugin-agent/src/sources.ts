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
// Add a shared insertion action and a view using ctx.mountTextEditor with textPolicy:defineTextPolicy({defaultMode:"${brief.view?.textMode === "rich" ? "rich" : "plain"}",enter:"newline"}), framed with blockContainer — never inline styles.
export default defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [] });\n`,
    "src/plugin.stories.ts": `import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/editor/testing";
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
  await expect(text).${brief.view?.textMode === "rich" ? "toHaveTextContent" : "toHaveValue"}("A useful note");
  await userEvent.clear(text);
  await userEvent.type(text, "Edited in Storybook");
  await expect(text).${brief.view?.textMode === "rich" ? "toHaveTextContent" : "toHaveValue"}("Edited in Storybook");
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
  paths.push("packages/editor/src/controller.ts", "packages/editor/src/dom.ts", "packages/editor/src/actions.ts", "packages/editor/src/rich-text.ts", "packages/editor/src/document-selection.ts", "packages/editor/src/pm-surface.ts", "packages/editor/src/testing.ts", "packages/design/src/nooq.css", "packages/plugin-agent/package.json", "bun.lock");
  return hash(JSON.stringify(await Promise.all(paths.sort().map(async p => [p, hash(await readFile(join(repo, p), "utf8"))]))));
}

export async function contextSections(): Promise<Record<string, string>> {
  const read = (p: string) => readFile(join(repo, p), "utf8");
  return {
    recipes: await read("packages/plugins/src/recipes.ts") + `\nPrefer these public helpers for standard behavior. Example: const note=defineBlockSchema({type:"example.note/v1",label:"Note",text:"inline",fields:{mood:field.enum(["calm","urgent"],"calm")}}); const cycle=cycleFieldCommand(note,"mood",{id:"example.note.cycle",label:"Cycle mood"}); const insert=insertBlockCommand(note,{id:"example.note.insert",label:"Insert note"}); Register all three in definePlugin. Schema diagnostics preserve unfamiliar stored data. Helpers supply validation, liveness, fresh IDs, atomic slash consumption and selection. apiVersion stays 1; these are additive SDK features, not a stored data migration.`,
    overview: `Generate a complete developer-bundled inline-text block plugin. Edit only src/index.ts, src/dom.ts and src/plugin.stories.ts. Default exports: Plugin, DOMPlugin, and CSF metadata respectively. Commands include the target-field commands AND the insertion command in the brief. Insertion args: {parent:string|null,index?:number,clearBlock?:string}; create through ctx.createBlock, optionally consume exactly '/' in clearBlock, then insert and request selection. If clearBlock changed, decline without mutation. No implicit dependencies or extra contributions. The manifest is harness-owned. No jobs, export formats or new core APIs in this recipe.`,
    headless: await read("packages/plugins/src/definitions.ts") + "\n" + await read("packages/core/src/model.ts") + "\n" + (await read("packages/core/src/text.ts")).split("export class TextChangeError")[0] + `\nInsertion pattern for an unrelated example.note/v1: const created = ctx.createBlock("example.note/v1"); return {status:"ready", ops:[{op:"insert",block:created,parent:args.parent,index:args.index}], selection:{block:created.id,anchor:0,head:0}}. To consume exactly '/', prepend {op:"textEdit",block:args.clearBlock,changes:[{delete:1}]} after verifying that block is alive and its text is exactly '/'. TextChange uses retain/insert/delete steps, never start/end/inserted offsets. Validate optional index as an integer and optional clearBlock as a string. Decline a missing/deleted parent. Do not use any/as never casts to hide mismatched operation shapes.`,
    dom: await read("packages/plugins/src/dom.ts") + "\n" + await read("packages/plugins/src/actions.ts") + "\n" + await read("packages/plugins/src/text-policy.ts") + "\n" + await read("packages/plugins/src/selection.ts") + `\nPUBLIC IMPORTS: Block and Immutable are exported by @nooq/plugins, NOT @nooq/plugins/dom. BlockView, BlockViewContext, and RichTextBinding are exported by @nooq/plugins/dom. If extracting a mount function, annotate its return: function mount(ctx: BlockViewContext): BlockView { ... }; this infers update(block) correctly. An import from the wrong entry point is a repairable type error, not an API gap.\nUse document.createElement inside mount only. Prefer textPolicy:defineTextPolicy({defaultMode:BRIEF_TEXT_MODE,enter:"newline"}) and ctx.mountTextEditor({label}); defaultMode is rich for a rich brief, otherwise plain. The application may override presentation at mount. Callout Enter stays a literal newline even with Writing Basics installed. A writing block may declare enter:{command:registeredSplitCommand}; it receives {block,anchor,head}. Shift+Enter inserts a newline. Do not register a global Enter shortcut for one block type. marks restricts formatting actions without rewriting stored marks. Explicit mountRichText/mountText remain compatibility bindings. App hosts can enable document selection with textMode:rich and selectionMode:document. Standard host rich text participates automatically; keep controls outside the binding and the child slot after its text. Do not install global selection, copy/cut/paste, or cross-block edit handlers in a block plugin. Mixed document range edits preserve block identity/fields/children. Compatible schemas may explicitly opt into textMerge:same-type for adjacent leaf siblings with identical fields; the host joins through the selected nooq.text.merge, text edit, and delete commands in one authorized transaction. Do not opt in a custom block without testing same-type equal-field joins, incompatible-field and child barriers, opaque suffix marks, and refused deletion. Do not implement joins in DOM handlers. Plain legacy bindings are barriers. Retain ctx.children.element. update(block) updates field display without replacing the text binding. Keep each native button's visible text equal to its accessible action label; show changing field values in a separate text element. Prefer defineAction({id,label,command:typedCommand,args:ctx=>({block:ctx.block}),placements:["toolbar"],when:ctx=>ctx.snapshot.blocks[ctx.block]?.type===block.type,enabled:ctx=>validCurrentField || "Explain why unavailable"}). Register actions on defineDOMPlugin and append ctx.mountActionToolbar({label:"Block actions"}).element inside mount. The host owns button labels, availability, selection, and cleanup. Define the insertion action with placements:["slash"] and args:insertAfterSelection. Legacy menus and native buttons using ctx.run remain supported. Availability must be synchronous and read-only; it does not authorize edits. Use update(block) for field display; avoid redundant whole-document subscriptions. Show the brief's view.field value visibly as String(value), including non-string invalid values. Use the exported insertAfterSelection as the menu args function. Avoid innerHTML. Frame the block with blockContainer from @nooq/plugins/dom (re-exported from @nooq/design): the header carries the label word and the tone, the state slot the visible field value, the body the text binding, then children and controls. Refresh tone and word in update(block) with setBlockContainerTone. Never assign Element.style (cssText, setProperty, or properties) and never write hex colors: the conformance check rejects both, and colors and borders belong to the host theme. No network, storage, globals or timers.`,
    stories: await read("packages/editor/src/testing.ts") + `\nUse standard CSF3 Meta<PluginStoryArgs>/StoryObj<PluginStoryArgs> from @storybook/html-vite (type-only), expect from storybook/test, and the supplied mountPluginStory helper from @nooq/editor/testing. Export ALL named stories from brief.view.stories. Each requires a play function with awaited assertions using canvas role/label queries. Get userEvent from the play context: play: async ({canvas,userEvent}) => {...}. Default MUST edit the textbox with userEvent.clear/type and assert the result. Rich contenteditable uses toHaveTextContent; legacy textarea uses toHaveValue. For rich briefs, RichFormatting must call text.focus() before selecting the textbox content via document.getSelection()?.selectAllChildren(text), activate bold with await userEvent.keyboard("{Control>}b{/Control}"), and assert text.querySelector("strong") has the expected text. Do not call textarea selection/value APIs on contenteditable. KeyboardCycle must focus the native button (button.focus() or awaited tab), activate with await userEvent.keyboard("{Enter}") and assert the visible changed field. Initial focus is not guaranteed. NestedContent uses args.children:true and asserts canvas.getByRole("textbox",{name:"Text block"}) with toHaveValue("Nested child"), since textarea values are not text nodes. InvalidTone uses an invalid stored field and checks that it remains. With an enabled guard, assert the button is disabled and has the explanatory accessible description; otherwise click and check preservation. Cover default, alternate field states and text editing. beforeEach must return disposePluginStories as cleanup. Never disable a11y or test checks, catch failed assertions, use fixture IDs, import the editor directly, or change the oracle. These stories run with Storybook's composition/run lifecycle in Chromium, in light and dark themes, followed by an independent axe audit.`,
  };
}
