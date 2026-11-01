import { expect, test } from "bun:test";
import { completeFixture } from "./complete-fixture.ts";
import { parseBrief } from "../src/brief.ts";
import { checkSourcePolicy } from "../src/check.ts";
import { candidatePaths, scaffoldPackage } from "../src/sources.ts";

const brief = parseBrief(await Bun.file(new URL("../briefs/callout-complete.json", import.meta.url)).json());

test("a source that sets styles directly fails the policy", () => {
  for (const source of [
    'const el = document.createElement("div"); el.style.cssText = "border:1px solid red";',
    'el.style.setProperty("border", "1px solid red");',
    'el.style.color = "red";',
    'el.style.borderColor = "#ff0000";',
    'el.style["background-color"] = "red";',
    'el.style = "color: red";',
  ]) {
    const errors = checkSourcePolicy(source, "src/dom.ts");
    expect(errors.some(e => e.includes("Element.style"))).toBe(true);
  }
});

test("reading style without assigning it is not a violation", () => {
  expect(checkSourcePolicy('const hidden = el.style.display === "none";', "src/dom.ts")).toEqual([]);
});

test("hex color literals fail the policy, in strings and in templates", () => {
  for (const source of [
    'el.textContent = "#ff0000";',
    'const c = "#f00";',
    'const c = "#abcd";',
    'const c = `#aabbcc`;',
    'const c = `border: 1px solid ${"#aabbccdd"}`;',
  ]) {
    const errors = checkSourcePolicy(source, "src/dom.ts");
    expect(errors.some(e => e.includes("Hex color literal"))).toBe(true);
  }
});

test("prose that merely contains a hash is not a color", () => {
  for (const source of [
    'const note = "See issue #12 before the #1 release.";',
    'const anchor = "#heading-anchor";',
    'const id = "#deadline";',
  ]) {
    expect(checkSourcePolicy(source, "src/dom.ts")).toEqual([]);
  }
});

test("a container-based view with no styles or colors passes", () => {
  const source = `import { blockContainer } from "@nooq/design";
import type { BlockView, BlockViewContext } from "@nooq/plugins/dom";
export function mount(ctx: BlockViewContext): BlockView {
  const status = document.createElement("span");
  status.setAttribute("aria-live", "polite");
  status.textContent = \`Tone: \${String(ctx.snapshot().blocks[ctx.block]?.fields.tone)}\`;
  const text = ctx.mountTextEditor({ label: "Callout text" });
  const element = blockContainer({ label: "Callout", tone: "neutral", state: status, body: text.element, children: ctx.children.element, controls: ctx.mountActionToolbar().element });
  return { element, update() {}, destroy: () => text.destroy() };
}`;
  expect(checkSourcePolicy(source, "src/dom.ts")).toEqual([]);
});

test("@nooq/design is importable by views and stories, not by the headless entry", () => {
  expect(checkSourcePolicy('import { blockContainer } from "@nooq/design";', "src/dom.ts")).toEqual([]);
  expect(checkSourcePolicy('import { blockContainer } from "@nooq/design";', "src/plugin.stories.ts")).toEqual([]);
  expect(checkSourcePolicy('import { blockContainer } from "@nooq/design";', "src/index.ts")).not.toEqual([]);
});

test("the rebuilt callouts fixture passes the policy at every candidate path", async () => {
  const sources = await completeFixture();
  for (const path of candidatePaths) expect(checkSourcePolicy(sources[path], path)).toEqual([]);
  const rich = await completeFixture(true);
  for (const path of candidatePaths) expect(checkSourcePolicy(rich[path], path)).toEqual([]);
});

test("the deterministic scaffold still passes the policy", () => {
  const sources = scaffoldPackage(brief);
  for (const path of candidatePaths) expect(checkSourcePolicy(sources[path], path)).toEqual([]);
});
