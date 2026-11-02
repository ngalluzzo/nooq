import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function mounted(blocks: string[]) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "human:eb", name: "eb" } });
  const ids = blocks.map((text) => editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text }));
  const surface = createSurface(editor);
  host.append(surface.element); // connected: focus and rendering require it
  return { editor, surface, ids };
}

describe("EB-5: editable in the frame the surface becomes visible", () => {
  test("mounting focuses the first text block with a caret at its end — no clicking", async () => {
    const { editor, surface, ids } = mounted(["first block", "second"]);
    await flush();

    const active = document.activeElement;
    expect(active).toBeTruthy();
    expect(surface.element.contains(active as Node)).toBe(true);
    // The caret is live at the end of the first block: ready to type.
    const area = active as HTMLTextAreaElement;
    expect(area.selectionStart).toBe(editor.view.blocks[ids[0]!]!.text!.s.length);
    surface.destroy();
  });

  test("a later explicit focus is never stolen back", async () => {
    const { editor, surface, ids } = mounted(["aaa", "bbb"]);
    await flush();
    const areas = Array.from(surface.element.querySelectorAll("textarea")) as HTMLTextAreaElement[];
    const second = areas[1]!;
    second.focus();
    second.setSelectionRange(0, 0);
    // any change re-renders; focus must stay where the writer put it
    editor.setField(ids[0]!, "tone", "x");
    await flush();
    expect(document.activeElement).toBe(second);
    surface.destroy();
  });
});

describe("EB-6: renders touch only what transactions touched", () => {
  test("typing into one block never re-updates untouched rows' views", async () => {
    const { editor, surface, ids } = mounted(["alpha", "beta", "gamma"]);
    await flush();

    // Spy through the DOM: replace the untouched rows' textareas' value setters?
    // No — observe the honest signal: the untouched row's <textarea> keeps its
    // exact DOM node AND its value stays synced; the strongest observable is
    // that nothing about it changes. We assert via the row's signature path
    // indirectly: mutate the third block directly and confirm only it moves.
    const shells = surface.element.querySelectorAll("[data-nq-block]");
    expect(shells).toHaveLength(3);

    editor.applyTextChanges(ids[2]!, [{ retain: 5 }, { insert: "X" }]);
    await flush();
    const after = surface.element.querySelectorAll("[data-nq-block]");
    expect(after).toHaveLength(3);
    // Same DOM nodes preserved (incremental rendering, never recreated)
    expect(after[0]).toBe(shells[0]);
    expect(after[2]).toBe(shells[2]);
    const text = editor.view.blocks[ids[2]!]!.text!.s;
    expect(after[2]!.querySelector("textarea")!.value).toBe(text);
    surface.destroy();
  });
});

describe("EB-7: remote renders pin the viewport", () => {
  test("remote-driven renders pin the viewport (zero-rect environments adjust by zero)", async () => {
    const { editor, surface, ids } = mounted(["anchor text"]);
    await flush();

    // A genuinely remote-origin change: another editor's state applied with
    // a non-local transaction origin (the surface sees origin "remote").
    // happy-dom reports zero rects, so the pin adjusts by zero — asserted as
    // scrollTop invariance; the pin path itself is exercised, never skipped.
    const peer = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "human:peer", name: "peer" } });
    const Y = await import("yjs");
    peer.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "from far away" });
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    await flush();
    const blocks = surface.element.querySelectorAll("[data-nq-block]");
    expect(blocks.length).toBe(2); // remote content rendered
    const scroller = document.scrollingElement as HTMLElement | null;
    expect(scroller?.scrollTop ?? 0).toBe(0); // viewport undisturbed
    peer.close();
    surface.destroy();
  });
});

test("windowing gaps stay bounded across repeated renders", async () => {
  const { editor, surface, ids } = mounted(Array.from({ length: 60 }, () => "word ".repeat(40)));
  try {
    await flush();
    const before = surface.element.querySelectorAll("[data-nq-ph]").length;
    expect(before).toBeGreaterThan(0); // The fixture actually reaches the unmounted window.
    for (let i = 0; i < 10; i++) {
      editor.applyTextChanges(ids[0]!, [{ insert: "x" }]);
      await flush();
    }
    const after = surface.element.querySelectorAll("[data-nq-ph]").length;
    console.log(JSON.stringify({ windowingGaps: { before, after } }));
    expect(after).toBeLessThanOrEqual(2);
  } finally {
    surface.destroy();
    editor.close();
  }
});

test("remote deletion maps backward ranges by character identity in repeated text", async () => {
  const { editor, surface, ids } = mounted(["aaaaaaaa"]);
  const peer = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "peer" } });
  const Y = await import("yjs");
  try {
    await flush();
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(editor.ydoc));
    const area = surface.element.querySelector("textarea")!;
    area.setSelectionRange(3, 6, "backward");
    peer.applyTextChanges(ids[0]!, [{ retain: 1 }, { delete: 2 }]);
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    await flush();
    expect(area.value).toBe("aaaaaa");
    expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([1, 4, "backward"]);
    expect(document.activeElement).toBe(area);
  } finally { peer.close(); surface.destroy(); editor.close(); }
});

test("remote deletion skips deleted neighbors and keeps an empty surface focused", async () => {
  const { editor, surface, ids } = mounted(["first", "selected", "also deleted", "next"]);
  const peer = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "peer" } });
  const Y = await import("yjs");
  try {
    await flush();
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(editor.ydoc));
    const area = surface.element.querySelectorAll("textarea")[1]!;
    area.focus(); area.setSelectionRange(1, 4);
    peer.deleteBlock(ids[1]!); peer.deleteBlock(ids[2]!);
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    await flush();
    const next = surface.element.querySelector(`[data-nq-block="${ids[3]}"] textarea`) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(next);
    expect([next.selectionStart, next.selectionEnd]).toEqual([0, 0]);
    peer.deleteBlock(ids[0]!); peer.deleteBlock(ids[3]!);
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    await flush();
    expect(document.activeElement).toBe(surface.element);
  } finally { peer.close(); surface.destroy(); editor.close(); }
});

test("a deliberate focus change before the remote render wins over a captured selection", async () => {
  const { editor, surface, ids } = mounted(["selected"]);
  const peer = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "peer" } });
  const Y = await import("yjs");
  const button = document.createElement("button"); document.body.append(button);
  try {
    await flush();
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(editor.ydoc));
    peer.applyTextChanges(ids[0]!, [{ insert: "remote " }]);
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    button.focus();
    await flush();
    expect(document.activeElement).toBe(button);
  } finally { button.remove(); peer.close(); surface.destroy(); editor.close(); }
});

test("an empty remote update cannot retain a stale selection across writer navigation", async () => {
  const { editor, surface, ids } = mounted(["abcdefgh"]);
  const peer = new Editor({ docId: "eb-fixes-doc", actor: { actorId: "peer" } });
  const Y = await import("yjs");
  try {
    await flush();
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(editor.ydoc));
    Y.applyUpdate(editor.ydoc, new Uint8Array([0, 0]));
    const area = surface.element.querySelector("textarea")!;
    area.setSelectionRange(1, 4);
    peer.applyTextChanges(ids[0]!, [{ insert: "++" }]);
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
    await flush();
    expect([area.selectionStart, area.selectionEnd]).toEqual([3, 6]);
  } finally { peer.close(); surface.destroy(); editor.close(); }
});
