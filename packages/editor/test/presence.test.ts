/**
 * Remote presence over the surface (SW-7): selections paint as CSS custom
 * highlights and carets in an overlay, never inside text hosts. happy-dom has
 * no highlight registry, so a fake one stands in for the browser's.
 */
import "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { peerInk } from "@nooq/design";
import { NooqRelay, settled } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

const DOC = "presence-doc";
const globals = globalThis as unknown as { Highlight?: unknown };
const css = Object.getOwnPropertyDescriptor(globalThis, "CSS");
/** happy-dom's CSS is a fresh object per read: pin one that carries the registry. */
function fakeHighlights() {
  const registry = new Map<string, Set<AbstractRange>>();
  Object.defineProperty(globalThis, "CSS", { value: { highlights: registry }, configurable: true, writable: true });
  globals.Highlight = class extends Set<AbstractRange> {};
  return registry;
}
afterEach(() => { if (css) Object.defineProperty(globalThis, "CSS", css); delete globals.Highlight; });

/** Settle the wire, then let the overlay's frame (and the ink hash it may wait on) run. */
async function painted() {
  for (let i = 0; i < 3; i++) { await settled(); await new Promise(resolve => requestAnimationFrame(resolve)); }
}
async function world() {
  const relay = new NooqRelay();
  const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice", name: "Alice" }, transport: relay.connect(DOC) });
  const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob", name: "Bob" }, transport: relay.connect(DOC) });
  const first = alice.insertBlock({ type: paragraph.type, parent: null, text: "Hello world" });
  const second = alice.insertBlock({ type: paragraph.type, parent: null, text: "Second line" });
  await settled();
  return { alice, bob, first, second };
}
const texts = (ranges: Set<AbstractRange> | undefined) => [...ranges ?? []].map(range => (range as Range).toString());

describe("presence overlay (SW-7)", () => {
  test("a cursor's anchor crosses the wire; peers that ignore it still have the caret", async () => {
    const { alice, bob, first, second } = await world();
    alice.setCursor({ block: second, offset: 3, anchor: { block: first, offset: 6 } });
    await settled();
    expect(bob.awareness.get("human:alice")?.cursor).toEqual({ block: second, offset: 3, anchor: { block: first, offset: 6 } });
    alice.close(); bob.close();
  });

  test("a remote selection is one highlight per ink over block text; the caret and flag sit in the overlay", async () => {
    const registry = fakeHighlights();
    const { alice, bob, first, second } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM], textMode: "rich" });
    document.body.append(surface.element);
    const name = `nq-peer-${await peerInk("human:alice")}`, hosts = () => Array.from(surface.element.querySelectorAll(".nq-rich-text"));
    const before = hosts().map(host => host.innerHTML);

    alice.setCursor({ block: second, offset: 3, anchor: { block: first, offset: 6 } });
    await painted();
    expect(texts(registry.get(name))).toEqual(["world", "Sec"]);
    const caret = surface.element.querySelector<HTMLElement>('.nq-presence [data-nq-actor="human:alice"]');
    expect(caret?.textContent).toContain("Alice");
    expect(surface.element.querySelectorAll("[data-nq-block] .nq-peer")).toHaveLength(0); // no chip in the block
    expect(hosts().map(host => host.innerHTML)).toEqual(before); // nothing written into text hosts

    alice.setCursor({ block: second, offset: 3 }); // collapsed: the highlight goes, the caret stays
    await painted();
    expect(registry.has(name)).toBe(false);
    expect(surface.element.querySelector('.nq-presence [data-nq-actor="human:alice"]')).not.toBeNull();

    alice.setCursor({ block: second, offset: 99, anchor: { block: second, offset: 7 } }); // ahead of our text: clamps
    await painted();
    expect(texts(registry.get(name))).toEqual(["line"]);

    surface.destroy();
    expect(registry.size).toBe(0); // a surface removes only what it added
    alice.close(); bob.close();
  });

  test("a plain-text row shows its peer as a chip in the writer's derived ink, never a borrowed one", async () => {
    const { alice, bob, first } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM] }); // no textMode: the textarea host
    document.body.append(surface.element);
    alice.setCursor({ block: first, offset: 3 });
    await painted();
    const chip = surface.element.querySelector<HTMLElement>(`[data-nq-block="${first}"] .nq-peer`);
    expect(chip?.getAttribute("data-ink")).toBe(await peerInk("human:alice"));
    expect(chip?.textContent).toContain("Alice");
    surface.destroy(); alice.close(); bob.close();
  });

  test("remote cursors stay on their characters through later edits, and wait for text they are ahead of (EB-7)", async () => {
    const registry = fakeHighlights();
    const { alice, bob, first, second } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM], textMode: "rich" });
    document.body.append(surface.element);
    const aliceInk = `nq-peer-${await peerInk("human:alice")}`, carolInk = `nq-peer-${await peerInk("human:carol")}`;

    alice.setCursor({ block: first, offset: 11, anchor: { block: first, offset: 6 } });
    await painted();
    expect(texts(registry.get(aliceInk))).toEqual(["world"]);
    bob.applyTextChanges(first, [{ insert: "Hey! " }]); // Bob types in front of it; Alice says nothing
    await painted();
    expect(texts(registry.get(aliceInk))).toEqual(["world"]);

    // Carol's update is still verifying when her cursor arrives: its caret is past our text's end.
    bob.awareness.set("human:carol", { actor: "human:carol", name: "Carol", cursor: { block: second, offset: 14, anchor: { block: second, offset: 11 } } });
    bob.applyTextChanges(first, [{ retain: 16 }, { insert: "." }]); // any change renders
    await painted();
    expect(registry.has(carolInk)).toBe(false);
    bob.applyTextChanges(second, [{ retain: 11 }, { insert: "!!!" }]); // her text lands
    await painted();
    expect(texts(registry.get(carolInk))).toEqual(["!!!"]);
    surface.destroy(); alice.close(); bob.close();
  });

  test("without the Highlight API the caret still renders and nothing throws", async () => {
    const { alice, bob, first } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM], textMode: "rich" });
    document.body.append(surface.element);
    alice.setCursor({ block: first, offset: 5, anchor: { block: first, offset: 0 } });
    await painted();
    expect(surface.element.querySelector('.nq-presence [data-nq-actor="human:alice"]')?.textContent).toContain("Alice");
    expect(bob.errors).toEqual([]);
    surface.destroy(); alice.close(); bob.close();
  });

  test("awareness is unauthenticated input: a malformed anchor is dropped, the caret kept (SW-7)", async () => {
    const registry = fakeHighlights();
    const { alice, bob, first } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM], textMode: "rich" });
    document.body.append(surface.element);
    const malformed = { block: first, offset: 2, anchor: { block: 7, offset: "x" }, extra: true } as unknown as { block: string; offset: number };
    bob.awareness.set("human:mallory", { actor: "human:mallory", name: "Mallory", cursor: malformed });
    bob.awareness.set("human:eve", { actor: "human:eve", name: "Eve", cursor: { block: first, offset: -1 } });
    bob.applyTextChanges(first, [{ insert: "!" }]); // any change renders
    await painted();
    expect(registry.size).toBe(0);
    expect(surface.element.querySelector('.nq-presence [data-nq-actor="human:mallory"]')?.textContent).toContain("Mallory");
    expect(surface.element.querySelector('.nq-presence [data-nq-actor="human:eve"]')).toBeNull();
    expect(bob.errors).toEqual([]);
    surface.destroy(); alice.close(); bob.close();
  });

  test("the surface announces the writer's selection, deduplicated", async () => {
    const { alice, bob, first, second } = await world();
    const surface = createSurface(bob, { plugins: [essentialsDOM], textMode: "rich", selectionMode: "document" });
    document.body.append(surface.element);
    await settled();
    const sent: unknown[] = [], setCursor = bob.setCursor.bind(bob);
    bob.setCursor = cursor => { sent.push(cursor); setCursor(cursor); };

    surface.selection!.set({ anchor: { block: first, offset: 2 }, head: { block: second, offset: 4 } });
    surface.element.dispatchEvent(new Event("mouseup", { bubbles: true }));
    await settled();
    expect(alice.awareness.get("human:bob")?.cursor).toEqual({ block: second, offset: 4, anchor: { block: first, offset: 2 } });
    surface.element.dispatchEvent(new Event("keyup", { bubbles: true }));
    await settled();
    expect(sent).toHaveLength(1);

    surface.selection!.set({ anchor: { block: first, offset: 3 }, head: { block: first, offset: 3 } });
    surface.element.dispatchEvent(new Event("mouseup", { bubbles: true }));
    await settled();
    expect(alice.awareness.get("human:bob")?.cursor).toEqual({ block: first, offset: 3 });
    surface.destroy(); alice.close(); bob.close();
  });
});
