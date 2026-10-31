import { readFile } from "node:fs/promises";
import type { Sources } from "../src/sources.ts";
export async function completeFixture(): Promise<Sources> {
  const source = await readFile(new URL("../../plugin-callouts/src/index.ts",import.meta.url),"utf8");
  const dom = await readFile(new URL("../../plugin-callouts/src/dom.ts",import.meta.url),"utf8");
  return {
    "src/index.ts": source.replaceAll("nooq.callout", "seed.callout") + "\nexport default callouts;\n",
    "src/dom.ts": dom.replace('label: "Callout"','label: "Insert callout"') + "\nexport default calloutsDOM;\n",
    "src/plugin.stories.ts": `import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { mountPluginStory, disposePluginStories, type PluginStoryArgs } from "@nooq/plugin-agent/storybook";
import plugin from "./index.ts"; import dom from "./dom.ts";
const meta={title:"Plugins/Callouts",render:(args)=>mountPluginStory(plugin,dom,args),beforeEach:()=>()=>disposePluginStories(),args:{text:"Story text",fields:{tone:"info"}}} satisfies Meta<PluginStoryArgs>;
export default meta;type Story=StoryObj<PluginStoryArgs>;
export const Default:Story={play:async({canvas,userEvent})=>{const text=await canvas.findByRole("textbox",{name:"Callout text"});await expect(text).toHaveValue("Story text");await userEvent.clear(text);await userEvent.type(text,"Typed in a story");await expect(text).toHaveValue("Typed in a story");}};
export const Warning:Story={args:{fields:{tone:"warning"}},play:async({canvas})=>{await expect(await canvas.findByText("Tone: warning")).toBeVisible();}};
export const Success:Story={args:{fields:{tone:"success"}},play:async({canvas})=>{await expect(await canvas.findByText("Tone: success")).toBeVisible();}};
export const InvalidTone:Story={args:{fields:{tone:"invalid"}},play:async({canvas,userEvent})=>{const button=await canvas.findByRole("button",{name:"Cycle callout tone"});await userEvent.click(button);await expect(await canvas.findByText("Tone: invalid")).toBeVisible();}};
export const KeyboardCycle:Story={play:async({canvas,userEvent})=>{const button=await canvas.findByRole("button",{name:"Cycle callout tone"});button.focus();await userEvent.keyboard("{Enter}");await expect(await canvas.findByText("Tone: warning")).toBeVisible();}};
export const NestedContent:Story={args:{children:true},play:async({canvas})=>{await expect(await canvas.findByRole("textbox",{name:"Text block"})).toHaveValue("Nested child");}};
`,
  };
}
