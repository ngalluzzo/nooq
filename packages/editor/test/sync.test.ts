import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@nooq/core";
import { NooqRelay, settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const DOC = "editor-sync-doc";

describe("reference editor: sync and presence (§2, SW-3/6/7)", () => {
  test("two editors converge through a hosted peer, offline-first throughout", async () => {
    const relay = new NooqRelay();
    const alice = new Editor({ docId: DOC, actor: { actorId: "human:alice", name: "Alice" }, transport: relay.connect(DOC) });
    const bob = new Editor({ docId: DOC, actor: { actorId: "human:bob", name: "Bob" }, transport: relay.connect(DOC) });
    const aliceSurface = createSurface(alice);
    const bobSurface = createSurface(bob);
    await settled();

    // Both write independently (concurrent divergence)
    const fromAlice = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "hello from alice" });
    const fromBob = bob.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "hello from bob" });
    await settled();

    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));
    expect(alice.view.blocks[fromAlice]!.text!.s).toBe("hello from alice");
    expect(alice.view.blocks[fromBob]!.text!.s).toBe("hello from bob");

    // Alice announces a cursor; Bob's surface renders her presence caret (SW-7)
    alice.setCursor({ block: fromAlice, offset: 5 });
    await settled();
    expect(bob.awareness.get("human:alice")?.cursor).toEqual({ block: fromAlice, offset: 5 });
    const caret = bobSurface.element.querySelector(".nq-peer");
    expect(caret?.textContent).toContain("Alice");

    // AI proposes to Alice; Bob sees the same suggestion card state
    await alice.propose({
      ops: [{ op: "textEdit", block: fromBob, replace: { s: "HELLO FROM BOB", marks: "HELLO FROM BOB".split("").map(() => []) } }],
      evidence: [fromBob],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settled(5);
    const bobCard = Array.from(bobSurface.element.querySelectorAll<HTMLElement>("article.nq-sugg")).find((c) => c.dataset.state === "fresh");
    expect(bobCard).toBeDefined();

    // Bob accepts on his side; Alice converges to the adopted content
    const suggestion = [...Object.values(bob.view.blocks)].find((b) => b.type === "nooq.suggestion/v1")!;
    await bob.accept(suggestion.id);
    await settled(5);
    expect(alice.view.blocks[fromBob]!.text!.s).toBe("HELLO FROM BOB");
    expect(canonicalJson(alice.view)).toBe(canonicalJson(bob.view));

    aliceSurface.destroy();
    bobSurface.destroy();
    alice.close();
    bob.close();
  });

  test("an editor with no transport is fully functional (§2)", async () => {
    const editor = new Editor({ docId: "solo", actor: { actorId: "human:solo", name: "Solo" } });
    const surface = createSurface(editor);
    const block = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "offline and fine" });
    await settled(2);
    expect(surface.element.querySelector(".nq-sync")?.textContent).toContain("Saved on this device");
    expect(editor.view.blocks[block]!.text!.s).toBe("offline and fine");
    expect(editor.hasTransport).toBe(false);
    surface.destroy();
    editor.close();
  });
});
