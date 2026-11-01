import { chromium, type Locator } from "playwright";
import { resolve, sep } from "node:path";
import assert from 'node:assert/strict';
const root = resolve(import.meta.dir, "../storybook-static");
if (!await Bun.file(resolve(root, "iframe.html")).exists()) throw new Error("Build Storybook before running the native selection check");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const path = resolve(root, "." + pathname + (pathname.endsWith("/") ? "index.html" : ""));
  if (!path.startsWith(root + sep)) return new Response("Not found", { status: 404 });
  const file = Bun.file(path); return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1100,height:950}, permissions:['clipboard-read','clipboard-write']});
const page = await context.newPage(), errors:string[]=[]; page.on('pageerror',e=>errors.push(String(e)));
page.setDefaultTimeout(10000);
const base=server.url.href, mod=process.platform==='darwin'?'Meta':'Control';
async function load() {
  await page.goto(`${base}iframe.html?id=plugins-document-selection--mixed-range&viewMode=story`);
  await page.getByRole('button',{name:'Select paragraph and Callout'}).waitFor();
  await page.waitForFunction(()=>document.getSelection()?.toString().includes('pha'));
}
const first=page.getByRole('textbox',{name:'Text',exact:true}).first();
const note=page.getByRole('textbox',{name:'Callout text',exact:true});
async function coord(locator: Locator,offset: number) {
  return locator.evaluate((el,n)=>{
    const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node=w.nextNode();
    while(node && n>node.textContent!.length){n-=node.textContent!.length;node=w.nextNode();}
    const r=document.createRange(); if (!node) throw new Error("Text offset missing");
    r.setStart(node,n);r.setEnd(node,Math.min(n+1,node.textContent!.length)); const b=r.getBoundingClientRect();
    return {x:b.left+1,y:b.top+b.height/2};
  },offset);
}
async function drag(backward=false) {
  const a=await coord(first,2),h=await coord(note,5),start=backward?h:a,end=backward?a:h;
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});await page.mouse.up();
}
await load(); const ids=await page.locator('[data-nq-block]').evaluateAll(es=>es.map(e=>e.dataset.nqBlock));
await drag(); await page.keyboard.press(`${mod}+c`);
await page.waitForFunction(async()=>await navigator.clipboard.readText()==='pha 😀\nA cal');
assert.equal(await page.evaluate(()=>(document.activeElement as HTMLElement)?.dataset.nqDocumentSelection),'true');

await page.evaluate(()=>navigator.clipboard.writeText('PASTED\ntext'));await page.keyboard.press(`${mod}+v`);
await page.waitForFunction(()=>document.querySelector('[aria-label="Text"]')?.textContent==='AlPASTED\ntext');
assert.equal(await note.textContent(),'lout');assert.deepEqual(await page.locator('[data-nq-block]').evaluateAll(es=>es.map(e=>e.dataset.nqBlock)),ids);
assert.equal(await page.getByRole('textbox',{name:'Text',exact:true}).nth(1).textContent(),'Nested text');
console.log('Native forward drag, clean clipboard copy, and cross-block paste passed');
await load();await drag(true);await page.keyboard.press(`${mod}+x`);
await page.waitForFunction(()=>document.querySelector('[aria-label="Text"]')?.textContent==='Al');
assert.equal(await note.textContent(),'lout'); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'pha 😀\nA cal');
console.log('Native backward drag and cut passed');
await load();await first.evaluate(e=>{e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=document.getSelection()!;s.removeAllRanges();s.addRange(r)});
await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press(`${mod}+c`);
await page.waitForFunction(async()=>await navigator.clipboard.readText()==='\nA');
await page.keyboard.press(`${mod}+a`);await page.keyboard.press(`${mod}+b`);
await page.waitForFunction(()=>document.querySelector('[aria-label="Callout text"] strong')?.textContent==='A callout');
assert.equal(await page.getByRole('textbox',{name:'Text block'}).locator('strong').textContent(),'Unknown text');
console.log('Native keyboard extension, select-all, and formatting across nested/unknown text passed');
const mergeTexts = page.getByRole('textbox', { name: 'Text', exact: true });
async function loadMerge() {
  await page.goto(`${base}iframe.html?id=plugins-structural-merging--ready-to-merge&viewMode=story`);
  await page.waitForFunction(() => document.getSelection()?.rangeCount && document.getSelection()!.getRangeAt(0).toString().includes('Middle'));
}
await loadMerge();
const mergeIds = await page.locator('[data-nq-block]').evaluateAll(es => es.map(e => e.dataset.nqBlock));
const start = await coord(mergeTexts.nth(2), 2), end = await coord(mergeTexts.nth(0), 2);
await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
await page.keyboard.press(`${mod}+c`);
await page.waitForFunction(async () => await navigator.clipboard.readText() === 'pha 😀\nMiddle\nOm');
await page.evaluate(() => navigator.clipboard.writeText('PASTED\ntext')); await page.keyboard.press(`${mod}+v`);
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'AlPASTED\ntextega');
assert.deepEqual(await page.locator('[data-nq-block]').evaluateAll(es => es.map(e => e.dataset.nqBlock)), [mergeIds[0], mergeIds[3]]);
assert.equal(await mergeTexts.locator('em').textContent(), 'ega');
assert.equal(await mergeTexts.locator('[data-nq-marks]').textContent(), 'ega');
await page.keyboard.type('!');
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'AlPASTED\ntext!ega');
console.log('Native backward range drag, structural paste, opaque marks, and continued typing passed');

await loadMerge(); await page.getByRole('button', { name: 'Place caret at second paragraph start' }).click();
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'Alpha 😀Middle');
await page.keyboard.type('!');
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'Alpha 😀!Middle');
assert.equal(await mergeTexts.count(), 2);
await loadMerge(); await mergeTexts.first().evaluate(el => {
  el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r);
});
await page.keyboard.press('Delete');
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'Alpha 😀Middle');
assert.equal(await mergeTexts.count(), 2);
console.log('Native boundary Backspace and Delete joins passed');

await loadMerge(); await page.keyboard.press(`${mod}+x`);
await page.waitForFunction(() => document.querySelector('[aria-label="Text"]')?.textContent === 'Alega');
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'pha 😀\nMiddle\nOm');
assert.equal(await mergeTexts.count(), 1);
assert.equal(await page.getByRole('textbox', { name: 'Callout text' }).textContent(), 'Protected callout');
console.log('Native structural cut preserves the incompatible neighboring block');
assert.deepEqual(errors,[]);console.log(`Native selection checks passed in Chromium ${browser.version()}; no page errors`);
} finally { await browser?.close(); server.stop(true); }
