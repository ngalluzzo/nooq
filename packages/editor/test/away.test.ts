/** Away markers (foundation P1): remote changes to blocks outside the window mark them; exactly three clears; a session-local lifetime. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { NooqRelay, settled } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { createSurface, type EditorSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";
import { createAwayTracker, type AwayTracker } from "../src/away.ts";

const PARAGRAPH = paragraph.type;
const WORD = "Changed while you were away";

/** The pure core against a controllable mounted set: no layout, no editor. Armed by default, as a surface with rows on screen would be. */
function tracker(mounted: readonly string[], armed = true): { away: AwayTracker; flips: string[] } {
  const flips: string[] = [];
  const away = createAwayTracker({ mountedIds: () => mounted, onFlip: block => flips.push(block) });
  if (armed) away.arm();
  return { away, flips };
}
const event = (origin: "local" | "remote", blocks: readonly string[]) => ({ revision: 1, origin, blocks });

describe("away tracker: detection (pure)", () => {
  test("a remote change to an unmounted block marks it; a mounted one never", () => {
    const { away, flips } = tracker(["a"]);
    away.observe(event("remote", ["a", "b"]));
    expect(away.isMarked("b")).toBe(true); // windowed-out is truth: not in the mounted ids when the event landed
    expect(away.isMarked("a")).toBe(false); // mounted (visible): the writer watched it happen
    expect(flips).toEqual(["b"]); // one flip, at mark time — marks never churn
  });

  test("mounted truth is read when the event lands, not before or after", () => {
    const mounted = ["b"];
    const { away } = tracker(mounted);
    away.observe(event("remote", ["b"]));
    expect(away.isMarked("b")).toBe(false);
    mounted.length = 0; // the block windowed out between events
    away.observe(event("remote", ["b"]));
    expect(away.isMarked("b")).toBe(true);
  });

  test("local changes never mark, whatever their blocks", () => {
    const { away, flips } = tracker([]);
    away.observe(event("local", ["b", "c"]));
    expect(away.markedIds().size).toBe(0);
    expect(flips).toEqual([]);
  });

  test("before the first content render arms detection, a remote bootstrap marks nothing", () => {
    const { away, flips } = tracker([], false); // no rows yet: the open state, not away
    away.observe(event("remote", ["a", "b", "c"])); // the whole document arrives at once
    expect(away.markedIds().size).toBe(0);
    expect(flips).toEqual([]);
    away.arm(); // the first render mounted rows
    away.observe(event("remote", ["d"]));
    expect(away.isMarked("d")).toBe(true); // steady state: detection exact from here on
  });
});

describe("away tracker: the three clears (pure)", () => {
  test("focus into the row clears: clear(), the focusin resolution's hook", () => {
    const { away, flips } = tracker([]);
    away.observe(event("remote", ["b"]));
    expect(away.clear("b")).toBe(true); // focus arrived in the row
    expect(away.isMarked("b")).toBe(false);
    expect(away.clear("b")).toBe(false); // nothing left to clear
    expect(flips).toEqual(["b", "b"]); // marked, then cleared
  });

  test("a local edit to the block clears it", () => {
    const { away } = tracker([]);
    away.observe(event("remote", ["b"]));
    away.observe(event("local", ["b"])); // the writer's own edit is a visit
    expect(away.isMarked("b")).toBe(false);
  });

  test("the block's history opening clears it: clear(), the nq:block-history listener's hook", () => {
    const { away } = tracker([]);
    away.observe(event("remote", ["b"]));
    expect(away.clear("b")).toBe(true); // opening the history is seeing the block's past
    expect(away.isMarked("b")).toBe(false);
  });
});

describe("away tracker: lifetime (pure)", () => {
  test("block deletion drops its mark; marks on live blocks stay", () => {
    const { away } = tracker([]);
    away.observe(event("remote", ["b", "c"]));
    away.prune(new Set(["c"])); // b left the live tree
    expect(away.isMarked("b")).toBe(false);
    expect(away.isMarked("c")).toBe(true);
  });

  test("unknown ids are ignored, never invented", () => {
    const { away, flips } = tracker(["a"]);
    expect(away.clear("nope")).toBe(false);
    away.observe(event("remote", []));
    away.prune(new Set());
    expect(away.markedIds().size).toBe(0);
    expect(flips).toEqual([]);
  });

  test("destroy drops everything and the tracker goes quiet", () => {
    const { away } = tracker([]);
    away.observe(event("remote", ["b"]));
    away.destroy();
    expect(away.markedIds().size).toBe(0);
    away.observe(event("remote", ["c"]));
    away.force("d");
    expect(away.markedIds().size).toBe(0); // session-local: nothing survives the surface
  });
});

describe("away wiring: the surface owns the DOM", () => {
  interface Fixture { editor: Editor; surface: EditorSurface; row(id: string): HTMLElement }
  function fixture(docId: string): Fixture {
    const editor = new Editor({ docId, plugins: [essentials], actor: { actorId: "human:writer" } });
    const surface = createSurface(editor, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    return { editor, surface, row(id) { const row = surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"]`); if (!row) throw new Error(`no row for ${id}`); return row; } };
  }
  const done = (f: Fixture) => { f.surface.destroy(); f.editor.close(); };

  test("a forced mark sets the shell attribute and injects the sr word; the treatment rides the view's bar", async () => {
    const f = fixture("away-force");
    const id = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "seen" });
    await settled(2);
    f.surface.away.force(id); // the seam: honest marking needs a windowed-out block, which a mounted harness cannot show
    const row = f.row(id);
    expect(row.hasAttribute("data-nq-away")).toBe(true); // the attribute the CSS keys on
    expect(row.querySelector(".nq-sr")?.textContent).toBe(WORD); // the word channel (§9)
    expect(row.querySelector(".nq-bar")).not.toBeNull(); // the bar stays the view's own — the notch is CSS
    done(f);
  });

  test("focus moving into the marked row clears the attribute and the word, without a render", async () => {
    const f = fixture("away-focus");
    const first = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "first" });
    const second = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "second" });
    await settled(2); // the first render auto-focuses the first row (EB-5), so the marked row starts unfocused
    f.surface.away.force(second);
    const row = f.row(second);
    expect(row.hasAttribute("data-nq-away")).toBe(true);
    row.querySelector<HTMLTextAreaElement>("textarea")!.focus(); // focus ENTERS the marked row
    expect(f.surface.away.isMarked(second)).toBe(false);
    expect(row.hasAttribute("data-nq-away")).toBe(false);
    expect(row.querySelector(".nq-sr")).toBeNull();
    done(f);
  });

  test("a local edit to the marked block clears it — typing is a visit", async () => {
    const f = fixture("away-local");
    const id = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "draft" });
    await settled(2);
    f.surface.away.force(id);
    const row = f.row(id);
    expect(row.hasAttribute("data-nq-away")).toBe(true);
    f.editor.editText(id, "draft, edited");
    await settled(2);
    expect(f.surface.away.isMarked(id)).toBe(false);
    expect(row.hasAttribute("data-nq-away")).toBe(false);
    expect(row.querySelector(".nq-sr")).toBeNull();
    done(f);
  });

  test("opening the block's history clears the mark (the surface's nq:block-history event)", async () => {
    const f = fixture("away-history");
    f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "first" }); // keeps the auto-focus off the marked row (EB-5)
    const second = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "second" });
    await settled(2);
    f.surface.away.force(second);
    const row = f.row(second);
    row.querySelector<HTMLElement>(".nq-bar-history")!.dispatchEvent(new CustomEvent("nq:block-history", { bubbles: true })); // the bar's own contract, without focusing it
    expect(f.surface.away.isMarked(second)).toBe(false); // cleared in the listener, before the popover opens
    expect(row.hasAttribute("data-nq-away")).toBe(false);
    expect(row.querySelector(".nq-sr")).toBeNull();
    await settled(2); // let the history popover the listener opened settle, then close it like a writer would
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settled(2);
    expect(document.querySelector("body > .nq-popover .nq-history")).toBeNull();
    done(f);
  });

  test("a deleted block's mark drops with it; the row's other marks are untouched", async () => {
    const f = fixture("away-delete");
    const keep = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "keep" });
    const gone = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "gone" });
    await settled(2);
    f.surface.away.force(keep);
    f.surface.away.force(gone);
    f.editor.deleteBlock(gone);
    await settled(3);
    expect(f.surface.away.isMarked(gone)).toBe(false); // deletion ends the block's marks
    expect(f.surface.away.isMarked(keep)).toBe(true); // unmounting or deleting another block never clears
    expect(f.row(keep).hasAttribute("data-nq-away")).toBe(true);
    done(f);
  });

  test("surface destroy drops every mark (session-local; nothing persists)", async () => {
    const f = fixture("away-destroy");
    const id = f.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "gone" });
    await settled(2);
    f.surface.away.force(id);
    expect(f.surface.away.markedIds().size).toBe(1);
    f.surface.destroy();
    expect(f.surface.away.markedIds().size).toBe(0);
    f.editor.close();
  });
});

describe("away wiring: the real feed over the wire", () => {
  test("a remote edit to a mounted block never marks", async () => {
    const relay = new NooqRelay(), DOC = "away-remote-mounted";
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob" }, transport: relay.connect(DOC) });
    const surface = createSurface(bob, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    const id = bob.insertBlock({ type: PARAGRAPH, parent: null, text: "visible" });
    await settled(3); // bob's own insert renders and mounts the block
    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice" }, transport: relay.connect(DOC) });
    await settled(3);
    alice.editText(id, "visible, edited");
    await settled(3);
    expect(surface.away.isMarked(id)).toBe(false); // mounted when the change landed: bob watched it happen
    expect(surface.element.querySelector<HTMLElement>(`[data-nq-block="${id}"]`)!.hasAttribute("data-nq-away")).toBe(false);
    surface.destroy();
    bob.close();
    alice.close();
  });

  test("a remote change naming a block not yet mounted marks it — the honest detection path", async () => {
    const relay = new NooqRelay(), DOC = "away-remote-unmounted";
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob" }, transport: relay.connect(DOC) });
    const surface = createSurface(bob, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    bob.insertBlock({ type: PARAGRAPH, parent: null, text: "anchor" });
    await settled(3);
    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice" }, transport: relay.connect(DOC) });
    await settled(3);
    const fresh = alice.insertBlock({ type: PARAGRAPH, parent: null, text: "arrived while away" });
    await settled(3);
    // The event landed before the render that mounts the new block: marked,
    // then mounted notched — mounting never clears.
    expect(surface.away.isMarked(fresh)).toBe(true);
    const row = surface.element.querySelector<HTMLElement>(`[data-nq-block="${fresh}"]`)!;
    expect(row.hasAttribute("data-nq-away")).toBe(true);
    expect(row.querySelector(".nq-sr")?.textContent).toBe(WORD);
    surface.destroy();
    bob.close();
    alice.close();
  });

  test("opening onto a document a peer already wrote marks nothing — the open state is not away", async () => {
    const relay = new NooqRelay(), DOC = "away-remote-open";
    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice" }, transport: relay.connect(DOC) });
    alice.insertBlock({ type: PARAGRAPH, parent: null, text: "already here" });
    alice.insertBlock({ type: PARAGRAPH, parent: null, text: "also here" });
    await settled(3);
    // Bob's surface opens AFTER the content exists: the bootstrap names every
    // block before the first content render, and none of it changed while he
    // was away — he watched the document open.
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob" }, transport: relay.connect(DOC) });
    const surface = createSurface(bob, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    await settled(5);
    expect(surface.away.markedIds().size).toBe(0);
    expect(surface.element.querySelectorAll("[data-nq-away]").length).toBe(0);
    // Steady state from here: a later remote change to a windowed-out block marks.
    const fresh = alice.insertBlock({ type: PARAGRAPH, parent: null, text: "arrived later" });
    await settled(3);
    expect(surface.away.isMarked(fresh)).toBe(true);
    surface.destroy();
    bob.close();
    alice.close();
  });
});
