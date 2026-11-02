/** The document header (foundation P2): chrome above the surface — the live sync line, the roster, and the host's title slot. */
import "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { announcer, type AnnouncerTiming } from "@nooq/design";
import { NooqRelay, settled } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { createDocumentHeader } from "../src/header.ts";
import { setSharedAnnouncer } from "../src/status.ts";

/** Never-flush timing: announcements queue and drop, so no test leaks timers. */
const quiet: AnnouncerTiming = { now: () => 0, schedule: () => () => {} };

/** Settle the wire, then let renders and the async ink hash land. */
async function painted(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) { await settled(); await new Promise(resolve => requestAnimationFrame(resolve)); }
}

afterEach(() => { setSharedAnnouncer(undefined); });

describe("document header", () => {
  test("mounts with the live sync line and roster peers through a real editor, no surface", async () => {
    setSharedAnnouncer(announcer(quiet));
    const relay = new NooqRelay(), DOC = "header-doc";
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob", name: "Bob" }, transport: relay.connect(DOC) });
    const bound = document.createElement("span"); bound.textContent = "Quarterly plan";
    const header = createDocumentHeader(bob, { title: bound, selfName: "Bob" });
    document.body.append(header.element);
    // The title slot renders what the host binds — the very node, uncloned.
    expect(header.element.querySelector(".nq-header-title")?.firstChild).toBe(bound);

    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice", name: "Alice" }, transport: relay.connect(DOC) });
    const block = alice.insertBlock({ type: paragraph.type, parent: null, text: "Hello world" });
    await painted();
    alice.setCursor({ block, offset: 2 });
    await painted();

    // The sync line reads the editor exactly as the surface reads it (DM-8, §2).
    const sync = header.element.querySelector<HTMLElement>(".nq-sync")!;
    expect(sync.dataset.state).toBe("synced");
    expect(sync.textContent).toBe("Synced · 1 peer");
    // And the roster beside it, through the same status module the surface uses.
    const self = header.element.querySelector(".nq-roster-self .nq-roster-name");
    expect(self?.textContent).toBe("Bob");
    const peer = header.element.querySelector<HTMLElement>(".nq-roster-peer")!;
    expect(peer.getAttribute("data-nq-actor")).toBe("human:alice");
    expect(peer.querySelector(".nq-roster-name")?.textContent).toBe("Alice");
    expect(peer.style.getPropertyValue("--nq-peer")).toMatch(/^var\(--nq-peer-/); // a resolved ink, never borrowed

    header.destroy();
    alice.close();
    bob.close();
  });

  test("the title slot renders nothing until a host binds one, and the sync line still reads the editor", async () => {
    setSharedAnnouncer(announcer(quiet));
    const editor = new Editor({ docId: "header-untitled", plugins: [essentials], actor: { actorId: "human:solo" } });
    const header = createDocumentHeader(editor);
    document.body.append(header.element);
    await painted(2);
    const slot = header.element.querySelector(".nq-header-title")!;
    expect(slot.childElementCount).toBe(0);
    expect(slot.textContent).toBe("");
    expect(header.element.querySelector(".nq-sync")?.textContent).toBe("Saved on this device"); // offline first (§2)
    header.destroy();
    editor.close();
  });

  test("destroy removes the header and stops following the editor; the editor keeps working", async () => {
    const live = announcer(quiet);
    setSharedAnnouncer(live);
    const relay = new NooqRelay(), DOC = "header-destroy";
    const bob = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:bob" }, transport: relay.connect(DOC) });
    const header = createDocumentHeader(bob, { selfName: "Bob" });
    document.body.append(header.element);
    await painted(2);
    expect(header.element.contains(live.element)).toBe(true); // the shared live region rides with the status area
    header.destroy();
    expect(header.element.isConnected).toBe(false);
    expect(header.element.querySelector(".nq-roster")).toBeNull(); // the status module's nodes went with it

    // The shared announcer is never replaced by a destroy (status.ts owns the
    // singleton): the next header re-homes the very same region.
    const second = createDocumentHeader(bob, { selfName: "Bob" });
    document.body.append(second.element);
    expect(second.element.contains(live.element)).toBe(true);

    // No surface dependency and no posthumous work: the editor stays editable,
    // a joining peer changes nothing the destroyed header still owns, and nothing throws.
    const alice = new Editor({ docId: DOC, plugins: [essentials], actor: { actorId: "human:alice", name: "Alice" }, transport: relay.connect(DOC) });
    const block = alice.insertBlock({ type: paragraph.type, parent: null, text: "peer text" });
    await painted();
    alice.setCursor({ block, offset: 2 });
    const written = bob.insertBlock({ type: paragraph.type, parent: null, text: "still editable" });
    await painted();
    expect(bob.view.blocks[written]!.text!.s).toBe("still editable");
    expect(header.element.querySelector(".nq-roster")).toBeNull();

    second.destroy();
    alice.close();
    bob.close();
  });
});
