import { expect, test } from "bun:test";
import { sandboxAvailable } from "./sandbox-capability.ts";
import { completeFixture } from "./complete-fixture.ts";
import { parseBrief } from "../src/brief.ts";
import { checkSourcePolicy, validatePackage } from "../src/check.ts";
import { packageHash, scaffoldPackage } from "../src/sources.ts";
import { isolated } from "./isolated.ts";
import type { CompleteValidation } from "../src/check.ts";
import type { BrowserChecks } from "../src/browser.ts";
const brief=parseBrief(await Bun.file(new URL("../briefs/callout-complete.json",import.meta.url)).json());
const richBrief=parseBrief(await Bun.file(new URL("../briefs/callout-rich.json",import.meta.url)).json());
const macTest=process.platform==="darwin"&&sandboxAvailable?test:test.skip;

test("complete recipe validates view/story links and confines edits/imports",()=>{
  expect(()=>parseBrief({...brief,view:{...brief.view,controls:[{command:"absent",label:"Wrong"}]}})).toThrow();
  expect(()=>parseBrief({...brief,insertCommand:undefined})).toThrow();
  expect(checkSourcePolicy('import x from "./dom.ts";')).not.toEqual([]);
  expect(checkSourcePolicy('import x from "../secret.ts";',"src/dom.ts")).not.toEqual([]);
  expect(checkSourcePolicy('document.createElement("div")')).not.toEqual([]);
  expect(checkSourcePolicy('import {expect} from "storybook/test";',"src/plugin.stories.ts")).toEqual([]);
  const sources=scaffoldPackage(brief), changed={...sources,"src/dom.ts":sources["src/dom.ts"]+"\n// revision"};
  expect(packageHash(sources)).not.toBe(packageHash(changed));
});
macTest("complete package has independent runtime, browser and Storybook gates",async()=>{
  const sources=await completeFixture();
  const partial=await validatePackage(sources,brief,{stage:"types"});
  expect(partial.ok).toBe(true);expect(partial.complete).toBe(false);expect(partial.gates.find(g=>g.name==="browser")!.status).toBe("not-run");
  const full=await isolated<CompleteValidation>('import {validatePackage} from "../src/check.ts"; const {sources,brief}=await Bun.stdin.json(); console.log(JSON.stringify(await validatePackage(sources,brief)));',{sources,brief});
  expect(full.errors).toEqual([]);
  expect([...full.conformance?.checks??[],...full.runtime?.checks??[],...full.browser?.checks??[]].filter(c=>!c.ok)).toEqual([]);
  expect(full.complete).toBe(true);expect(full.browser!.stories).toBe(12);
},90_000);
macTest("broken generated stories fail even when independent plugin checks pass",async()=>{
  const sources=await completeFixture();sources["src/plugin.stories.ts"]=sources["src/plugin.stories.ts"].replace('toHaveValue("Story text")','toHaveValue("WRONG EXPECTATION")');
  const result=await isolated<BrowserChecks>('import {runBrowserChecks} from "../src/browser.ts"; const {sources,brief}=await Bun.stdin.json(); console.log(JSON.stringify(await runBrowserChecks(sources,brief)));',{sources,brief});
  expect(result.checks.filter(c=>c.name.startsWith("browser:")).every(c=>c.ok)).toBe(true);
  expect(result.checks.some(c=>c.name.startsWith("storybook: Default")&&!c.ok)).toBe(true);
},90_000);

macTest("rich recipe validates contenteditable, formatting, composition and portable stories", async () => {
  const sources = await completeFixture(true);
  const result = await isolated<CompleteValidation>('import {validatePackage} from "../src/check.ts"; const {sources,brief}=await Bun.stdin.json(); console.log(JSON.stringify(await validatePackage(sources,brief)));', { sources, brief: richBrief });
  expect(result.errors).toEqual([]);
  expect(result.browser?.checks.filter(c => !c.ok)).toEqual([]);
  expect(result.complete).toBe(true); expect(result.browser!.stories).toBe(14);
}, 90_000);

macTest("rich requirement cannot be satisfied by a passing legacy textarea plugin", async () => {
  const sources = await completeFixture(false);
  const result = await isolated<BrowserChecks>('import {runBrowserChecks} from "../src/browser.ts"; const {sources,brief}=await Bun.stdin.json(); console.log(JSON.stringify(await runBrowserChecks(sources,brief)));', { sources, brief: { ...brief, view: { ...brief.view!, textMode: "rich" } } });
  expect(result.checks.find(c => c.name.startsWith("browser: real view"))!.ok).toBe(false);
}, 90_000);
