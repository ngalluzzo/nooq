/** The error channel made visible: the surface shows one dismissable notice (foundation: Notice). */
import "./dom.ts";
import { expect, test } from "bun:test";
import { defineBlock, definePlugin } from "@nooq/plugins";
import { defineDOMPlugin } from "@nooq/plugins/dom";
import { settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const broken = defineBlock({ type: "test.broken/v1", label: "Broken", text: "none", create: () => ({ fields: {} }), diagnose: () => [] });
const brokenPlugin = definePlugin({ id: "test.broken", version: "1.0.0", apiVersion: 1, contributes: { blocks: [broken] } });
const brokenDOM = defineDOMPlugin({ id: "test.broken.dom", forPlugin: brokenPlugin, views: [{ type: broken.type, mount() { throw new Error("mount exploded"); } }] });

test("a view failure shows one notice naming the plugin and phase, and Dismiss clears it", async () => {
  const editor = new Editor({ docId: "notices", actor: { actorId: "writer" }, plugins: [brokenPlugin] });
  editor.insertBlock({ type: broken.type, parent: null });
  const surface = createSurface(editor, { plugins: [brokenDOM] });
  document.body.append(surface.element);
  await settled();
  const notice = surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='error']");
  // The word names the actor and the cause (content fundamentals); the block fell back, not vanished.
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent).toContain("test.broken.dom failed in view: mount exploded");
  expect(surface.element.querySelector(".nq-fallback")).not.toBeNull();
  notice!.querySelector<HTMLButtonElement>("button")!.click();
  expect(surface.element.querySelector(".nq-notice")).toBeNull();
  surface.destroy();
  editor.close();
});

test("a destroyed surface shows nothing further", async () => {
  const editor = new Editor({ docId: "notices-gone", actor: { actorId: "writer" }, plugins: [brokenPlugin] });
  const surface = createSurface(editor, { plugins: [brokenDOM] }); // no broken block exists: nothing has failed yet
  await settled();
  expect(surface.element.querySelector(".nq-notice")).toBeNull();
  surface.destroy();
  editor.reportError({ phase: "view", cause: new Error("after destroy") });
  expect(surface.element.querySelector(".nq-notice")).toBeNull();
  editor.close();
});
