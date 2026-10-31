import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { canonicalJson, makeBlock, newBlockId, type Op, type Transaction } from "@nooq/core";
import { applyTransaction, newDocument, readState } from "@nooq/yjs";
import { BACKEND, decodeMessage, encodeMessage, NooqRelay, REMOTE_ORIGIN, settled, SyncSession, type AwarenessEntry } from "../src/index.ts";
import { rt } from "./rt.ts";

const DOC = "wire-test-doc";
const ALICE = "human:alice";
const BOB = "human:bob";

function tx(ops: Op[], lamport: number, actorId: string): Transaction {
  return { id: newBlockId(), actor: { actorId, kind: "human" }, lamport, causality: {}, ops };
}

/** Alice's document: a section with two paragraphs. */
function aliceDocument(): { doc: Y.Doc; section: string; p1: string; p2: string } {
  const doc = newDocument(DOC);
  const section = makeBlock({ type: "nooq.section/v1" }, ALICE);
  const p1 = makeBlock({ type: "nooq.paragraph/v1", text: rt("first paragraph") }, ALICE);
  const p2 = makeBlock({ type: "nooq.paragraph/v1", text: rt("second paragraph") }, ALICE);
  applyTransaction(doc, tx([{ op: "insert", block: section, parent: null }], 1, ALICE));
  applyTransaction(doc, tx([{ op: "insert", block: p1, parent: section.id }], 2, ALICE));
  applyTransaction(doc, tx([{ op: "insert", block: p2, parent: section.id }], 3, ALICE));
  return { doc, section: section.id, p1: p1.id, p2: p2.id };
}

function connect(relay: NooqRelay, doc: Y.Doc, actor: string): SyncSession {
  const session = new SyncSession({ doc, transport: relay.connect(DOC), actor });
  session.start();
  return session;
}

describe("wire envelope (SW-2)", () => {
  test("unknown version and type decode to null", () => {
    expect(decodeMessage(JSON.stringify({ v: 99, t: "update", doc: DOC, update: "" }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ v: 1, t: "hologram", doc: DOC }))).toBeNull();
    expect(decodeMessage("not json")).toBeNull();
  });

  test("round-trips every message kind", () => {
    const messages = [
      { v: 1 as const, t: "hello" as const, doc: DOC, backend: BACKEND, sv: null },
      { v: 1 as const, t: "update" as const, doc: DOC, update: "eHl6" },
      { v: 1 as const, t: "awareness" as const, doc: DOC, actor: ALICE, cursor: { block: "b", offset: 3 } },
      { v: 1 as const, t: "error" as const, doc: DOC, code: "backend-mismatch" },
    ];
    for (const message of messages) {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    }
  });
});

describe("bootstrap and steady state through a hosted peer (SW-3/4/6)", () => {
  test("a fresh peer bootstraps, verifies, and converges", async () => {
    const relay = new NooqRelay();
    const alice = aliceDocument();
    const aliceSession = connect(relay, alice.doc, ALICE);
    await settled();

    const bobDoc = newDocument(DOC);
    let synced = false;
    const bobSession = new SyncSession({
      doc: bobDoc,
      transport: relay.connect(DOC),
      actor: BOB,
      onSynced: () => (synced = true),
    });
    bobSession.start();
    await settled();

    expect(synced).toBe(true);
    expect(canonicalJson(readState(bobDoc))).toBe(canonicalJson(readState(alice.doc)));
    expect(canonicalJson(readState(bobDoc))).toBe(canonicalJson(readState(relay.stored(DOC)!)));
    aliceSession.close();
    bobSession.close();
  });

  test("live updates flow and converge without acks", async () => {
    const relay = new NooqRelay();
    const alice = aliceDocument();
    const bobDoc = newDocument(DOC);
    connect(relay, alice.doc, ALICE);
    const bobSession = connect(relay, bobDoc, BOB);
    await settled();

    applyTransaction(
      alice.doc,
      tx([{ op: "textEdit", block: alice.p1, replace: rt("edited later") }], 4, ALICE),
    );
    await settled();

    expect(canonicalJson(readState(bobDoc))).toBe(canonicalJson(readState(alice.doc)));
    bobSession.close();
  });

  test("duplicate updates change nothing (SW-1.3)", async () => {
    const relay = new NooqRelay();
    const alice = aliceDocument();
    const bobDoc = newDocument(DOC);
    connect(relay, alice.doc, ALICE);
    connect(relay, bobDoc, BOB);
    await settled();

    const before = canonicalJson(readState(bobDoc));
    const update = Y.encodeStateAsUpdate(alice.doc);
    Y.applyUpdate(bobDoc, update, REMOTE_ORIGIN); // first application
    const afterFirst = canonicalJson(readState(bobDoc));
    Y.applyUpdate(bobDoc, update, REMOTE_ORIGIN); // duplicate
    expect(canonicalJson(readState(bobDoc))).toBe(afterFirst);
    expect(afterFirst).toBe(before); // nothing new was in the duplicate
  });

  test("a lying relay is caught by bootstrap verification (SW-3)", async () => {
    const relay = new NooqRelay({ lieAboutDigest: true });
    const alice = aliceDocument();
    connect(relay, alice.doc, ALICE);
    await settled();

    const bobDoc = newDocument(DOC);
    const errors: Array<{ code: string; message?: string }> = [];
    let synced = false;
    const bobSession = new SyncSession({
      doc: bobDoc,
      transport: relay.connect(DOC),
      actor: BOB,
      onError: (error) => errors.push(error),
      onSynced: () => (synced = true),
    });
    bobSession.start();
    await settled();

    expect(synced).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("verification-failed");
    // Discard means discard: Bob's document stayed empty.
    expect(Object.keys(readState(bobDoc).blocks)).toHaveLength(0);
    bobSession.close();
  });

  test("backend mismatch fails the handshake (SW-3)", async () => {
    const relay = new NooqRelay();
    const errors: Array<{ code: string }> = [];
    const transport = relay.connect(DOC);
    const session = new SyncSession({
      doc: newDocument(DOC),
      transport,
      actor: BOB,
      onError: (error) => errors.push(error),
    });
    // Hand-craft a hello with an unregistered backend.
    transport.send(JSON.stringify({ v: 1, t: "hello", doc: DOC, backend: "automerge/1", sv: null }));
    await settled();
    expect(errors.map((error) => error.code)).toContain("backend-mismatch");
    session.close();
  });
});

describe("awareness (SW-7)", () => {
  test("cursors announce block-anchored positions and reach the other peer", async () => {
    const relay = new NooqRelay();
    const alice = aliceDocument();
    connect(relay, alice.doc, ALICE);
    const seen: AwarenessEntry[] = [];
    const bobSession = new SyncSession({
      doc: newDocument(DOC),
      transport: relay.connect(DOC),
      actor: BOB,
      onAwareness: (entry) => seen.push(entry),
    });
    bobSession.start();
    await settled();

    const aliceSession = connect(relay, alice.doc, ALICE);
    await settled();
    aliceSession.setCursor({ block: alice.p1, offset: 5 });
    await settled();

    expect(seen).toContainEqual({ actor: ALICE, name: null, cursor: { block: alice.p1, offset: 5 } });

    // The cursor survives a structural edit to the document because it is
    // anchored to identity, not position (DM-4/SW-7).
    applyTransaction(alice.doc, tx([{ op: "move", block: alice.p2, newParent: alice.section, index: 0 }], 6, ALICE));
    await settled();
    const last = seen.at(-1)!;
    expect(last.cursor).toEqual({ block: alice.p1, offset: 5 });
    aliceSession.close();
    bobSession.close();
  });

  test("awareness never enters document state (SW-1.5)", async () => {
    const relay = new NooqRelay();
    const alice = aliceDocument();
    const before = canonicalJson(readState(alice.doc));
    const aliceSession = connect(relay, alice.doc, ALICE);
    await settled();
    aliceSession.setCursor({ block: alice.p1, offset: 1 });
    await settled();
    expect(canonicalJson(readState(alice.doc))).toBe(before);
    aliceSession.close();
  });
});
