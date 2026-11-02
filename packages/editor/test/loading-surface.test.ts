/** The open state (foundation P2): the surface's loading host — never on the input path (§3). */
import "./dom.ts";
import { expect, test } from "bun:test";
import { createActorKey } from "@nooq/core";
import { settled } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

test("an instant local doc never shows the loading state", async () => {
  const editor = new Editor({ docId: "loading-instant", actor: { actorId: "writer" }, plugins: [essentials] });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  const surface = createSurface(editor, { plugins: [essentialsDOM] });
  document.body.append(surface.element);
  // The host is mounted and gated: inside the 300ms window it draws nothing.
  const host = surface.element.querySelector<HTMLElement>(".nq-loading")!;
  expect(host).not.toBeNull();
  expect(host.getAttribute("aria-busy")).toBeNull();
  expect(host.querySelector(".nq-logo")).toBeNull();
  await settled();
  // The first render and ready both settle inside the window: the host left
  // without ever showing, and the content is there.
  expect(surface.element.querySelector(".nq-loading")).toBeNull();
  expect(surface.element.querySelector(".nq-input")).not.toBeNull();
  surface.destroy();
  editor.close();
});

test("a load that outlives the window shows the loader, then clears it", async () => {
  // A keyed editor's ready runs real signing setup — the controlled delay —
  // and loadingDelay: 0 makes the show immediate, the seam the surface offers tests.
  const editor = new Editor({ docId: "loading-slow", actor: { actorId: "writer" }, plugins: [essentials], key: await createActorKey() });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  const surface = createSurface(editor, { plugins: [essentialsDOM], loadingDelay: 0 });
  document.body.append(surface.element);
  // Synchronously after the surface exists, neither the first render nor
  // ready has landed: the loader is the only thing showing.
  const host = surface.element.querySelector<HTMLElement>(".nq-loading")!;
  expect(host.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector(".nq-sr")?.textContent).toBe("Loading");
  expect(host.querySelector(".nq-logo")).not.toBeNull();
  await editor.ready;
  await settled();
  // Both halves landed: the host is gone and it never touched the content.
  expect(surface.element.querySelector(".nq-loading")).toBeNull();
  expect(surface.element.querySelector<HTMLTextAreaElement>(".nq-input")!.value).toBe("Maya writes in ink.");
  surface.destroy();
  editor.close();
});

test("a destroyed surface clears its loading host", async () => {
  const editor = new Editor({ docId: "loading-destroy", actor: { actorId: "writer" }, plugins: [essentials] });
  const surface = createSurface(editor, { plugins: [essentialsDOM], loadingDelay: 0 });
  document.body.append(surface.element);
  expect(surface.element.querySelector(".nq-loading")).not.toBeNull();
  surface.destroy();
  await settled();
  expect(document.body.contains(surface.element)).toBe(false); // the whole root, host included
  editor.close();
});
