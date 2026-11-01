/** The status area's presence half: roster, idle word, joins, leaves, stale transitions (foundation P1). */
import "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { ANNOUNCE_QUIET, announcer, type AnnouncerTiming } from "@nooq/design";
import { NooqRelay, settled } from "@nooq/sync";
import type { AwarenessEntry } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { replaceChanges } from "@nooq/core";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { essentialsDOM, referenceDOM, referenceJobBindings, referencePlugins } from "../src/reference.ts";
import { createSurfaceStatus, setSharedAnnouncer } from "../src/status.ts";

/** A deterministic clock: announcements flush only when the test advances past the quiet window. */
class FakeClock implements AnnouncerTiming {
  time = 0;
  private readonly tasks = new Map<() => void, { at: number; run: () => void }>();
  now(): number { return this.time; }
  schedule(delay: number, task: () => void): () => void {
    const entry = { at: this.time + delay, run: task };
    this.tasks.set(task, entry);
    return () => { this.tasks.delete(task); };
  }
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.tasks.values()].filter(entry => entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = due.at;
      this.tasks.delete(due.run);
      due.run();
    }
    this.time = target;
  }
}

/** Settle the wire, then let renders and the async ink hash land. */
async function painted(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) { await settled(); await new Promise(resolve => requestAnimationFrame(resolve)); }
}

afterEach(() => { setSharedAnnouncer(undefined); });

describe("surface status: the roster beside the sync line", () => {
  test("peers appear once their ink resolves; joins and leaves are announced", async () => {
    const clock = new FakeClock(), live = announcer(clock);
    setSharedAnnouncer(live);
    const relay = new NooqRelay(), DOC = "status-doc";
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob", name: "Bob" }, transport: relay.connect(DOC) });
    const surface = createSurface(bob, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    const block = bob.insertBlock({ type: paragraph.type, parent: null, text: "Hello world" });
    await painted(); // the baseline render: bob alone, nothing announced yet
    expect(live.element.textContent).toBe("");

    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice", name: "Alice" }, transport: relay.connect(DOC) });
    alice.setCursor({ block, offset: 2 });
    await painted();
    const roster = surface.element.querySelector<HTMLElement>(".nq-roster")!;
    // Self leads; the editor exposes only an actor ID, so that is the self name here.
    expect(roster.querySelector(".nq-roster-self .nq-roster-name")?.textContent).toBe("human:bob");
    const peer = roster.querySelector<HTMLElement>(".nq-roster-peer")!;
    expect(peer.getAttribute("data-nq-actor")).toBe("human:alice");
    expect(peer.querySelector(".nq-roster-name")?.textContent).toBe("Alice");
    expect(peer.style.getPropertyValue("--nq-peer")).toMatch(/^var\(--nq-peer-/); // a resolved ink, never borrowed
    expect(live.element.textContent).toBe("Alice joined.");

    // SW-7: a null cursor is the departure.
    alice.setCursor(null);
    await painted();
    expect(surface.element.querySelector(".nq-roster-peer")).toBeNull();
    expect(live.element.textContent).toBe("Alice joined."); // still inside the quiet window
    clock.advance(ANNOUNCE_QUIET);
    expect(live.element.textContent).toBe("Alice left.");

    surface.destroy();
    alice.close();
    bob.close();
  });

  test("a surface mounts beside the sync line and its roster replaces, never duplicates", async () => {
    setSharedAnnouncer(announcer(new FakeClock()));
    const editor = new Editor({ docId: "status-mount", plugins: [essentials], actor: { actorId: "human:solo" } });
    const surface = createSurface(editor, { plugins: [essentialsDOM] });
    document.body.append(surface.element);
    await painted(2);
    const statusArea = surface.element.firstElementChild!;
    const sync = statusArea.querySelector(".nq-sync")!;
    const roster = statusArea.querySelector(".nq-roster")!;
    expect(sync.isConnected).toBe(true);
    expect(roster.isConnected).toBe(true);
    expect(statusArea.querySelectorAll(".nq-roster")).toHaveLength(1); // one roster across renders
    expect(statusArea.querySelector(".nq-announcer")).not.toBeNull(); // the live region rides along
    surface.destroy();
    editor.close();
  });
});

describe("surface status: idle and key diffs (unit)", () => {
  test("idle arrives after five minutes without an awareness update, as a word, and activity clears it", () => {
    const clock = new FakeClock();
    setSharedAnnouncer(announcer(clock));
    const editor = new Editor({ docId: "status-idle", actor: { actorId: "human:bob" } });
    const status = createSurfaceStatus(editor, { inkOf: () => "violet" }, { selfName: "Bob", now: () => clock.now() });
    const entry: AwarenessEntry = { actor: "human:ana", name: "Ana", cursor: { block: "b", offset: 0 } };
    status.update([entry]);
    let peer = status.element.querySelector<HTMLElement>(".nq-roster-peer")!;
    expect(peer.hasAttribute("data-idle")).toBe(false);
    expect(peer.querySelector(".nq-roster-idle")).toBeNull();

    clock.advance(5 * 60 * 1000 + 1);
    status.update([entry]); // the same entry object: no activity signal
    peer = status.element.querySelector<HTMLElement>(".nq-roster-peer")!;
    expect(peer.hasAttribute("data-idle")).toBe(true);
    expect(peer.querySelector(".nq-roster-idle")?.textContent).toBe("idle");

    const fresh: AwarenessEntry = { ...entry, cursor: { block: "b", offset: 3 } }; // a new awareness message
    clock.advance(1);
    status.update([fresh]);
    expect(status.element.querySelector(".nq-roster-peer")!.hasAttribute("data-idle")).toBe(false);
    status.destroy();
    editor.close();
  });

  test("joined and left come from awareness key diffs; the first update is the baseline", () => {
    const clock = new FakeClock(), live = announcer(clock);
    setSharedAnnouncer(live);
    const editor = new Editor({ docId: "status-diff", actor: { actorId: "human:bob" } });
    const status = createSurfaceStatus(editor, { inkOf: () => "teal" }, { now: () => clock.now() });
    const ana: AwarenessEntry = { actor: "human:ana", name: "Ana", cursor: { block: "b", offset: 0 } };
    const bo: AwarenessEntry = { actor: "human:bo", name: "Bo", cursor: { block: "b", offset: 1 } };
    status.update([ana]); // baseline: Ana was already here
    expect(live.element.textContent).toBe("");
    status.update([ana, bo]);
    expect(live.element.textContent).toBe("Bo joined.");
    clock.advance(ANNOUNCE_QUIET);
    status.update([ana]); // Bo's entry gone
    expect(live.element.textContent).toBe("Bo left.");
    // A departure over the wire (SW-7 null cursor) leaves the same way.
    clock.advance(ANNOUNCE_QUIET);
    status.update([ana, { ...bo, cursor: null }]);
    clock.advance(ANNOUNCE_QUIET);
    expect(live.element.textContent).toBe("Bo left.");
    status.destroy();
    editor.close();
  });

  test("a peer whose ink has not resolved yet shows in no color at all", () => {
    setSharedAnnouncer(announcer(new FakeClock()));
    const editor = new Editor({ docId: "status-ink", actor: { actorId: "human:bob" } });
    const status = createSurfaceStatus(editor, { inkOf: () => undefined }, { selfName: "Bob" });
    status.update([{ actor: "human:ana", name: "Ana", cursor: { block: "b", offset: 0 } }]);
    expect(status.element.querySelector(".nq-roster-peer")).toBeNull(); // never a borrowed color
    expect(status.element.querySelector(".nq-roster-self")).not.toBeNull();
    status.destroy();
    editor.close();
  });
});

describe("surface status: the announcer wired into review", () => {
  test("a suggestion that goes stale says so once", async () => {
    const clock = new FakeClock(), live = announcer(clock);
    setSharedAnnouncer(live);
    const editor = new Editor({ plugins: referencePlugins, jobBindings: referenceJobBindings(), docId: "status-stale", actor: { actorId: "human:writer", name: "Writer" } });
    const surface = createSurface(editor, { plugins: referenceDOM });
    document.body.append(surface.element);
    const block = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "draft" });
    await settled(3);
    await editor.propose({
      ops: [{ op: "textEdit", block, changes: replaceChanges("draft", "Draft") }],
      evidence: [block],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settled(3); // the card renders fresh: the transition baseline
    expect(live.element.textContent).toBe("");
    editor.editText(block, "draft, edited"); // concurrent drift under the proposal
    await settled(3);
    expect(live.element.textContent).toBe("Suggestion is now stale.");
    const card = Array.from(surface.element.querySelectorAll<HTMLElement>("article.nq-sugg")).at(-1)!;
    expect(card.dataset.state).toBe("stale");
    surface.destroy();
    editor.close();
  });
});
