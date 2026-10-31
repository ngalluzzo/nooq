import { chromium, type Frame } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildCandidate } from "./build.ts";
import { type Sources, hash } from "./sources.ts";
import type { Brief } from "./brief.ts";
import type { Check } from "./conformance.ts";

export interface BrowserChecks { checks: Check[]; version: string; screenshot?: string; previewHash?: string; stories: number }
export const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const css = `:root{color-scheme:light;font:16px/1.55 system-ui;color:#24352f;background:#f5f5ef}*{box-sizing:border-box}body{margin:0;padding:24px}h1,h2,p{margin:0 0 12px}h1{font-size:28px}h2{font-size:18px}button{font:inherit;padding:7px 12px;border:1px solid #74867b;border-radius:6px;color:inherit;background:transparent;cursor:pointer}button:focus-visible,textarea:focus-visible{outline:3px solid #167b55;outline-offset:3px}textarea{display:block;width:100%;min-height:88px;padding:10px;font:inherit;color:inherit;background:transparent;border:1px solid #84948a;border-radius:6px;resize:vertical}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{min-width:0;padding:20px;background:#fff;border:1px solid #c7d0c8;border-radius:12px}aside{margin-bottom:12px}.nq-children{margin:12px 0 0 20px}.nq-fallback{margin:12px 0;padding:12px;border:1px dashed #8c9f92}.nq-status{font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere}header{margin-bottom:20px}nav{display:flex;gap:12px;margin:12px 0}small{display:block;color:#526759}[data-nq-theme=dark]{color-scheme:dark;color:#e3ebe5;background:#17241e}[data-nq-theme=dark] .panel{background:#223329;border-color:#5a7061}[data-nq-theme=dark] small{color:#bfd1c3}@media(max-width:720px){main{grid-template-columns:1fr}}`;
function frameHtml(script: string, body: string): string {
  const safeScript = script.replace(/<\/script/gi, "<\\/script"), digest = createHash("sha256").update(safeScript).digest("base64");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Plugin preview</title><style>${css}</style><body>${body}<script type="module">${safeScript}</script></body></html>`;
}
export function isolatedHtml(inner: string, title: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'self' about:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{margin:0}iframe{display:block;border:0;width:100%;height:100vh}</style><iframe title="Generated plugin playground" sandbox="allow-scripts" srcdoc="${escapeHtml(inner)}"></iframe></html>`;
}
export async function buildPreview(sources: Sources, brief: Brief): Promise<string> {
  const script = await buildCandidate(sources, `import plugin from "candidate-index"; import dom from "candidate-dom"; import {mountPreview} from ${JSON.stringify(join(import.meta.dir, "preview-page.ts"))}; const fixture = mountPreview(plugin,dom,${JSON.stringify(brief)}); Object.assign(window,{__nooqFixture:fixture});`, "browser");
  return isolatedHtml(frameHtml(script, `<header><small>NOOQ / GENERATED PLUGIN LAB</small><h1>${escapeHtml(brief.label)}</h1><p>Edit the real plugin and watch the peer without it stay in sync.</p><nav><button id="remote">Edit from peer</button><button id="reset">Reset demo</button></nav></header><main><section class="panel"><h2>With the plugin</h2><div id="author"></div><small>Type / in the empty block to insert another callout.</small></section><section class="panel"><h2>Peer without the plugin</h2><div id="peer"></div><small>Generic fallback. Unknown fields and children are retained.</small></section></main>`), `${brief.label} — working preview`);
}

export async function runBrowserChecks(sources: Sources, brief: Brief, artifactDir?: string): Promise<BrowserChecks> {
  const checks: Check[] = [], html = await buildPreview(sources, brief);
  const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: String(error).slice(0, 3000) }); } };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  let served = html;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/" ? new Response(served, { headers: { "content-type": "text/html", "cache-control": "no-store" } }) : new Response("Not found", { status: 404 }); } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: false });
  const failures: string[] = [], requests: string[] = [];
  await context.route("**/*", route => {
    if (route.request().url() === server.url.href && route.request().resourceType() === "document") return route.continue();
    requests.push(route.request().url().slice(0, 160)); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on("pageerror", e => failures.push(String(e)));
  let timer: ReturnType<typeof setTimeout> | undefined, frame: Frame;
  let stories = 0;
  try {
    timer = setTimeout(() => { void browser.close(); }, 90_000);
    await page.goto(server.url.href); frame = page.frames().find(f => f.parentFrame())!;
    await frame.waitForFunction(() => !!(window as any).__nooqFixture);
    const target = await frame.evaluate(() => (window as any).__nooqFixture.target as string);
    const row = frame.locator(`#author [data-nq-block="${target}"]`), text = row.getByRole("textbox", { name: brief.view!.textLabel, exact: true });
    await check("browser: real view mounts, labelled text/controls and nested content", async () => {
      assert(await text.count() === 1, "Expected one labelled text controller");
      assert(await row.getByRole("button", { name: brief.view!.controls[0]!.label, exact: true }).count() === 1, "Missing accessible command button");
      assert(await row.getByRole("textbox", { name: "Text block", exact: true }).inputValue() === "Nested child", "Child container missing");
      assert(await row.locator(".nq-fallback").count() === 1, "Candidate view failed to mount or children missing");
    });
    await check("browser: native keyboard activation dispatches exactly one field command", async () => {
      const before = await frame.evaluate(() => (window as any).__nooqFixture.a.view.log.length);
      await row.getByRole("button", { name: brief.view!.controls[0]!.label, exact: true }).focus(); await page.keyboard.press("Enter");
      const scenario = brief.commands.find(c => c.id === brief.view!.controls[0]!.command)!.cases[0]!;
      await frame.waitForFunction(({target,field,value}) => JSON.stringify((window as any).__nooqFixture.a.view.blocks[target].fields[field]) === value, { target, field: brief.view!.field, value: JSON.stringify(scenario.expectedFields![brief.view!.field]) });
      assert((await row.textContent())!.includes(String(scenario.expectedFields![brief.view!.field])), "View does not display the updated field");
      assert(await frame.evaluate(() => (window as any).__nooqFixture.a.view.log.length) === before + 1, "Button dispatched more than once");
    });
    await check("browser: typing and remote splice preserve text controller and caret", async () => {
      await text.fill("abc"); await text.focus(); await text.evaluate((el: HTMLTextAreaElement) => { (window as any).__savedText = el; el.setSelectionRange(1, 1); });
      await frame.evaluate(() => (window as any).__nooqFixture.remote());
      await text.waitFor();
      const result = await text.evaluate((el: HTMLTextAreaElement) => ({ same: el === (window as any).__savedText, text: el.value, caret: el.selectionStart, focused: el === document.activeElement }));
      assert(result.same && result.text === "++abc" && result.caret === 3 && result.focused, JSON.stringify(result));
    });
    await check("browser: composition event sequence rebases over a concurrent insertion", async () => {
      await text.fill("abc");
      await text.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.dispatchEvent(new CompositionEvent("compositionstart")); el.value = "abあc"; });
      await frame.evaluate(() => (window as any).__nooqFixture.remote());
      await text.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionend")));
      await frame.waitForFunction(target => (window as any).__nooqFixture.a.view.blocks[target].text.s === "++abあc", target);
    });
    await check("browser: missing-plugin peer retains identical data and fallback", async () => {
      await frame.waitForFunction(() => JSON.stringify((window as any).__nooqFixture.a.view) === JSON.stringify((window as any).__nooqFixture.b.view));
      assert(await frame.locator(`#peer [data-nq-block="${target}"]`).textContent().then(s => s!.includes(brief.blockType)), "Missing unknown-type fallback");
    });
    await check("browser: slash menu inserts atomically and focuses its new text", async () => {
      const source = await frame.evaluate(() => (window as any).__nooqFixture.source as string);
      const sourceArea = frame.locator(`#author [data-nq-block="${source}"] textarea`); await sourceArea.fill("/");
      const before = await frame.evaluate(() => (window as any).__nooqFixture.a.view.log.length);
      const menu = frame.locator('#author [role="option"]').filter({ hasText: brief.insertCommand!.label });
      await menu.click();
      const result = await frame.evaluate(({source,before}) => { const f=(window as any).__nooqFixture, state=f.a.view, id=state.roots[state.roots.indexOf(source)+1]; return {delta:state.log.length-before,old:state.blocks[source].text.s,type:state.blocks[id]?.type,focused:document.activeElement?.closest('[data-nq-block]')?.getAttribute('data-nq-block')===id}; }, {source,before});
      assert(result.delta === 1 && result.old === "" && result.type === brief.blockType && result.focused, JSON.stringify(result));
    });
    await check("browser: nested slash insertion keeps the actual parent and sibling order", async () => {
      const child = await frame.evaluate(() => (window as any).__nooqFixture.child as string);
      await frame.locator(`#author [data-nq-block="${child}"] textarea`).fill("/");
      await frame.locator('#author [role="option"]').filter({ hasText: brief.insertCommand!.label }).click();
      const result = await frame.evaluate(({target,child}) => { const f=(window as any).__nooqFixture, state=f.a.view, siblings=state.blocks[target].children, id=siblings[siblings.indexOf(child)+1]; return {cleared:state.blocks[child].text.s,type:state.blocks[id]?.type,focused:document.activeElement?.closest('[data-nq-block]')?.getAttribute('data-nq-block')===id}; }, {target,child});
      assert(result.cleared === "" && result.type === brief.blockType && result.focused, JSON.stringify(result));
    });
    if (artifactDir) { await writeFile(join(artifactDir, "preview.html"), html); await page.screenshot({ path: join(artifactDir, "preview.png"), fullPage: true }); }
    await check("browser: view disposal exactly once per mount", async () => {
      const result = await frame.evaluate(() => { const f=(window as any).__nooqFixture; f.close(); f.close(); return f.counts(); });
      assert(result.mounts === result.destroys, JSON.stringify(result));
    });
    // Actual Storybook composition and .run(), not a homemade replacement for play().
    const storyScript = await buildCandidate(sources, `
import * as exports from "candidate-stories";
import * as renderer from "@storybook/html/entry-preview";
import { composeStories } from "storybook/preview-api";
import { within, userEvent } from "storybook/test";
import axe from "axe-core";
import { disposePluginStories } from "@nooq/plugin-agent/storybook";
const stories = composeStories(exports, renderer);
const plays=Object.fromEntries(Object.entries(exports).filter(([name])=>name!=="default").map(([name,value])=>[name,typeof value.play==="function"]));
Object.assign(window,{__stories:Object.keys(stories), __plays:plays, __runStory:async(name,theme)=>{
  disposePluginStories(); document.body.replaceChildren(); document.documentElement.dataset.nqTheme=theme;
  const canvas=document.createElement("main");document.body.append(canvas);
  let edits=0;canvas.addEventListener("input",()=>edits++);
  try {
    await stories[name].run({canvasElement:canvas,canvas:within(canvas),userEvent:userEvent.setup({document})});
    if(name==="Default" && edits===0)throw new Error("Default must exercise textbox editing with userEvent.clear/type and assert the new value");
    const result=await axe.run(canvas,{rules:{region:{enabled:false},"page-has-heading-one":{enabled:false},"landmark-one-main":{enabled:false}}});
    if(result.violations.length)throw new Error(JSON.stringify(result.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>n.target)}))));
    return {ok:true};
  } catch(error){return {ok:false,error:String(error)}} finally {disposePluginStories();}
}});`, "browser");
    served = isolatedHtml(frameHtml(storyScript, ""), "Plugin stories");
    await page.goto(server.url.href); frame = page.frames().find(f => f.parentFrame())!;
    await frame.waitForFunction(() => !!(window as any).__stories);
    const names = await frame.evaluate(() => (window as any).__stories as string[]);
    await check("storybook: required CSF stories exported", async () => { assert(brief.view!.stories.every(n => names.includes(n)), `Expected ${brief.view!.stories.join(", ")}; received ${names.join(", ")}`); });
    for (const theme of ["light", "dark"]) for (const name of brief.view!.stories) await check(`storybook: ${name} / ${theme}: play and axe`, async () => {
      assert(await frame.evaluate(name => (window as any).__plays[name], name), "Story must supply a play function");
      const result = await frame.evaluate(({name,theme}) => (window as any).__runStory(name,theme), {name,theme});
      assert(result.ok, result.error); stories++;
    });
    await check("browser: no uncaught errors or network requests", async () => { assert(!failures.length && !requests.length, JSON.stringify({failures,requests})); });
    return { checks, version: browser.version(), stories, previewHash: hash(html), ...(artifactDir ? { screenshot: "preview.png" } : {}) };
  } finally { if(timer) clearTimeout(timer); await browser.close(); server.stop(true); }
}
