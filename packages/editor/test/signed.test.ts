import "./dom.ts";
import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  createActorKey,
  makeBlock,
  toBase64,
  type Access,
} from "@nooq/core";
import { readState } from "@nooq/yjs";
import { NooqRelay, settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";

const DOC = "signed-editor-doc";

async function keySet() {
  const owner = await createActorKey();
  const alice = await createActorKey();
  const bob = await createActorKey();
  const ai = await createActorKey();
  const access: Access = {
    owner: { actorId: "human:owner", key: toBase64(owner.publicBytes) },
    grants: [
      { actorId: "human:alice", key: toBase64(alice.publicBytes), role: "writer" },
      { actorId: "human:bob", key: toBase64(bob.publicBytes), role: "writer" },
      { actorId: "ai:reference", key: toBase64(ai.publicBytes), role: "suggester" },
    ],
  };
  return { owner, alice, bob, ai, access };
}

function signedEditor(
  relay: NooqRelay,
  keys: Awaited<ReturnType<typeof keySet>>,
  who: "owner" | "alice" | "bob",
): Editor {
  const actorId = who === "owner" ? "human:owner" : who === "alice" ? "human:alice" : "human:bob";
  const key = who === "owner" ? keys.owner : who === "alice" ? keys.alice : keys.bob;
  return new Editor({
    docId: DOC,
    actor: { actorId, name: who },
    transport: relay.connect(DOC),
    key,
    aiKey: keys.ai, // the simulated model plugin ships with every editor
  });
}

describe("signed editors through a hosted peer (B4, DM-12/13 over the wire)", () => {
  test("typed text flows as sealed envelopes and converges", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();

    const owner = signedEditor(relay, keys, "owner");
    owner.setAccess?.(keys.access);
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();

    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "typed on alice" });
    await settled();

    expect(canonicalJson(readState(alice.ydoc))).toBe(canonicalJson(readState(bob.ydoc)));
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("typed on alice");
    // Every shipped update is in the relay's envelope log (SW-3).
    expect(relay.envelopesOf(DOC).length).toBeGreaterThan(0);

    owner.close();
    alice.close();
    bob.close();
  });

  test("a hostile unsigned update is dropped by the relay; peers never see it", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    const owner = signedEditor(relay, keys, "owner");
    owner.setAccess?.(keys.access);
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();
    const before = canonicalJson(readState(bob.ydoc));

    // An attacker with a raw transport sends a bare update into a signed doc.
    const hostileTransport = relay.connect(DOC);
    const hostileDoc = readState(alice.ydoc);
    void hostileDoc;
    const maliciousBlock = makeBlock({ type: "nooq.paragraph/v1", text: { s: "evil", marks: ["", "", "", ""].map(() => []) } }, "human:attacker");
    // Build a plausible update payload claim; the relay must refuse it
    // regardless of content because it is unsigned in an access-controlled doc.
    hostileTransport.send(
      JSON.stringify({ v: 1, t: "update", doc: DOC, update: Buffer.from("garbage-but-irrelevant").toString("base64") }),
    );
    await settled();

    expect(canonicalJson(readState(bob.ydoc))).toBe(before);
    expect(canonicalJson(readState(alice.ydoc))).toBe(before);
    void maliciousBlock;

    owner.close();
    alice.close();
    bob.close();
  });

  test("an AI suggestion ships sealed; overreach dies at the relay (SW-6)", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    const owner = signedEditor(relay, keys, "owner");
    owner.setAccess?.(keys.access);
    const alice = signedEditor(relay, keys, "alice");
    const bob = signedEditor(relay, keys, "bob");
    await settled();

    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "make this shine" });
    await settled();

    // The simulated model plugin (running on alice's editor) proposes.
    const suggestionId = await alice.propose({
      ops: [{ op: "textEdit", block: paragraph, changes: [{ insert: "Make this shine" }] }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    await settled(6);
    // The suggestion reached bob as a sealed suggester envelope.
    expect(readState(bob.ydoc).blocks[suggestionId]).toBeDefined();

    // The AI tries to edit the paragraph directly through alice's own
    // editor path (a hostile plugin would do the same): denied at the
    // relay, so bob never receives it.
    const before = canonicalJson(readState(bob.ydoc));
    const aiTx = {
      id: crypto.randomUUID(),
      actor: { actorId: "ai:reference", kind: "ai" as const, model: "simulated/1" },
      lamport: 99,
      causality: {},
      ops: [{ op: "textEdit", block: paragraph, changes: [{ insert: "hijacked" }] }] as import("@nooq/core").Op[],
    } satisfies import("@nooq/core").Transaction as import("@nooq/core").Transaction;
    // Route through alice's signed path: applyCaptured applies locally,
    // the ship seals with the AI key, the relay must deny it.
    const { applyCaptured, sealEnvelope } = await import("@nooq/yjs");
    const captured = applyCaptured(alice.ydoc, aiTx, keys.ai, "ai:reference");
    const sealed = await sealEnvelope(alice.ydoc, aiTx, captured.update, keys.ai, "ai:reference");
    // Send through a raw transport as if a hostile client emitted it.
    const attacker = relay.connect(DOC);
    attacker.send(JSON.stringify({ v: 1, t: "update", doc: DOC, update: Buffer.from(captured.update).toString("base64"), envelope: sealed }));
    await settled(6);

    expect(canonicalJson(readState(bob.ydoc))).toBe(before);
    // Alice's local doc applied it (local-first), but the relay refused to
    // store or forward it — the split is the price of local application
    // before admission; bob's state is what the rules protect.
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("make this shine");

    owner.close();
    alice.close();
    bob.close();
  });

  test("a fresh signed peer bootstraps through the verified envelope log", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    const owner = signedEditor(relay, keys, "owner");
    owner.setAccess?.(keys.access);
    const alice = signedEditor(relay, keys, "alice");
    await settled();
    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "before bob joined" });
    await settled();

    const bob = signedEditor(relay, keys, "bob");
    await settled(6);
    expect(bob.synced).toBe(true);
    expect(readState(bob.ydoc).blocks[paragraph]!.text!.s).toBe("before bob joined");
    expect(readState(bob.ydoc).access?.owner.actorId).toBe("human:owner");

    owner.close();
    alice.close();
    bob.close();
  });
});
