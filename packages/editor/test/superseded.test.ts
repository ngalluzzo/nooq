/**
 * Superseded moves (DM-4.9, proposal 0010): the five acceptance behaviors
 * over a real relay. Every document is secured and every transaction ships
 * as a signed envelope — that is what makes each peer's history store hold
 * the other's transactions, ops and causality intact, which is what
 * detection reads.
 *
 * Concurrency is real, not simulated: the racing writes author in the same
 * synchronous tick, before either envelope can cross the relay (delivery
 * rides microtasks), so neither transaction's causality includes the other.
 * The register's concurrent-write winner is Yjs's clientID rule (the DM-4.7
 * realization), so each racing editor's clientID is pinned before its first
 * write — the winner is deterministic and the tests still verify it from
 * the merged register rather than trusting the pin.
 */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Transaction } from "@nooq/core";
import { commitSigned, layout, newDocument } from "@nooq/yjs";
import { NooqRelay, settled } from "@nooq/sync";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { Editor } from "../src/controller.ts";
import { createSurface, type EditorSurface } from "../src/dom.ts";
import { essentialsDOM } from "../src/reference.ts";

const PARAGRAPH = paragraph.type;

/** A secured document with two writer grants, its genesis already on the relay (the access-wiring pattern). */
async function raceDoc() {
  const relay = new NooqRelay();
  const ownerKey = await createActorKey();
  const aliceKey = await createActorKey(), bobKey = await createActorKey();
  const party = { actorId: "human:owner", kind: "human" as const, key: toBase64(ownerKey.publicBytes) };
  const { docId, nonce } = await createSecuredDocument(party);
  const access: Access = {
    owner: party,
    nonce,
    grants: [
      { actorId: "human:alice", key: toBase64(aliceKey.publicBytes), kind: "human", role: "writer" },
      { actorId: "human:bob", key: toBase64(bobKey.publicBytes), kind: "human", role: "writer" },
    ],
  };
  const doc = newDocument(docId);
  const tx: Transaction = { id: newBlockId(), actor: { actorId: "human:owner", kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access }] };
  const committed = await commitSigned(doc, tx, ownerKey, "human:owner");
  const transport = relay.connect(docId);
  transport.onMessage(() => {});
  transport.send(JSON.stringify({ v: 1, t: "update", doc: docId, update: Buffer.from(committed.update).toString("base64"), envelope: committed.envelope }));
  await settled(6);
  return { relay, docId, keys: new Map([["human:alice", aliceKey], ["human:bob", bobKey]]) };
}

interface Opened { editor: Editor; surface: EditorSurface }
function open(relay: NooqRelay, docId: string, keys: Map<string, Awaited<ReturnType<typeof createActorKey>>>, actorId: "human:alice" | "human:bob", clientID: number): Opened {
  const editor = new Editor({ docId, plugins: [essentials], actor: { actorId, name: actorId === "human:alice" ? "Alice" : "Bob" }, transport: relay.connect(docId), key: keys.get(actorId)! });
  editor.ydoc.clientID = clientID; // before any local write: the register's concurrent-write tiebreak (Yjs, DM-4.7) is by clientID
  const surface = createSurface(editor, { plugins: [essentialsDOM] });
  document.body.append(surface.element);
  return { editor, surface };
}

interface Drafted { alice: Opened; bob: Opened; target: string; home: string }
/** Alice drafts the raced document; Bob joins; both surfaces render, arm and know each other's names (awareness). */
async function draftedRace(clientAlice: number, clientBob: number): Promise<{ relay: NooqRelay; docId: string; keys: Map<string, Awaited<ReturnType<typeof createActorKey>>>; race: Drafted }> {
  const { relay, docId, keys } = await raceDoc();
  const alice = open(relay, docId, keys, "human:alice", clientAlice);
  await settled(4);
  const target = alice.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "the raced block" });
  const home = alice.editor.insertBlock({ type: PARAGRAPH, parent: null, text: "one destination" });
  await settled(8);
  const bob = open(relay, docId, keys, "human:bob", clientBob);
  await settled(8);
  // Names travel on awareness (the notice reads name ?? actorId): publish cursors, settle.
  alice.editor.setCursor({ block: target, offset: 0 });
  bob.editor.setCursor({ block: target, offset: 0 });
  await settled(8);
  return { relay, docId, keys, race: { alice, bob, target, home } };
}

const supersededNotice = (surface: EditorSurface): HTMLElement | null =>
  surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='superseded']");

const done = (...open: Opened[]): void => { for (const o of open.reverse()) { o.surface.destroy(); o.editor.close(); } };

describe("superseded moves (DM-4.9) over a real relay", () => {
  test("1. concurrent moves to different destinations: the loser is noticed naming the winner; the winner is silent", async () => {
    const { relay, race } = await draftedRace(11, 22); // bob's client wins the register's tiebreak
    const { alice, bob, target, home } = race;
    const seen: string[] = [], seenByWinner: string[] = [];
    alice.surface.superseded.onEvent(event => seen.push(event.winningActor));
    bob.surface.superseded.onEvent(event => seenByWinner.push(event.winningActor));
    expect(alice.surface.superseded.isArmed()).toBe(true); // both surfaces settled before the race
    expect(bob.surface.superseded.isArmed()).toBe(true);

    // True concurrency: both moves author before either envelope can cross the relay.
    alice.editor.moveBlock(target, home, 0); // alice: under her paragraph
    bob.editor.moveBlock(target, null, 0); // bob: to the root — a different destination
    await settled(14);

    // One winner, identical on both peers (DM-4.7): the register decides, not the pin.
    const onAlice = layout(alice.editor.ydoc).placement.get(target)!;
    const onBob = layout(bob.editor.ydoc).placement.get(target)!;
    expect(onAlice).toEqual(onBob);
    const winnerActor = onAlice.actor, winnerName = winnerActor === "human:alice" ? "Alice" : "Bob";
    const winner = winnerActor === "human:alice" ? alice : bob;
    const loser = winnerActor === "human:alice" ? bob : alice;
    expect(onAlice.parent).toBe(winnerActor === "human:bob" ? null : home); // the winner's destination is where the block lives

    // The loser's surface names the winner; the winner's shows nothing.
    const notice = supersededNotice(loser.surface)!;
    expect(notice).not.toBeNull();
    expect(notice.querySelector(".nq-notice-word")?.textContent).toBe(`${winnerName} moved this block at the same time you did. Their move won.`);
    expect(notice.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Move it anyway");
    expect(supersededNotice(winner.surface)).toBeNull();
    expect(seen).toEqual([winnerActor]);
    expect(seenByWinner).toEqual([]);
    done(bob, alice);
  }, 30_000);

  test("2. a race to the same destination is agreement: silent on both sides", async () => {
    const { relay, race } = await draftedRace(11, 22);
    const { alice, bob, target, home } = race;
    alice.editor.moveBlock(target, home, 0);
    bob.editor.moveBlock(target, home, 0); // same parent: the register holds parents, order is the array's (each index validates against its own pre-merge view)
    await settled(14);
    const onAlice = layout(alice.editor.ydoc).placement.get(target)!;
    const onBob = layout(bob.editor.ydoc).placement.get(target)!;
    expect(onAlice).toEqual(onBob); // one winner of the register's identity, as always
    expect(onAlice.parent).toBe(home); // ...and the outcome matches both intents
    expect(supersededNotice(alice.surface)).toBeNull(); // agreement, not loss (DM-4.9)
    expect(supersededNotice(bob.surface)).toBeNull();
    done(bob, alice);
  }, 30_000);

  test("3. a later, causally-after move of the same block: silent — history already tells that story", async () => {
    const { relay, race } = await draftedRace(11, 22);
    const { alice, bob, target, home } = race;
    const seen: string[] = [];
    bob.surface.superseded.onEvent(event => seen.push(event.winningActor));

    bob.editor.moveBlock(target, home, 0); // bob moves
    await settled(10); // alice sees it — her next transaction's causality includes it
    alice.editor.moveBlock(target, null, 0); // alice moves the same block LATER, a different destination
    await settled(10);
    expect(layout(bob.editor.ydoc).placement.get(target)!.parent).toBeNull(); // the later move took effect
    expect(supersededNotice(bob.surface)).toBeNull(); // a later edit is not a race (DM-4.9)
    expect(supersededNotice(alice.surface)).toBeNull();
    expect(seen).toEqual([]);

    // And again after seeing everything: the next move re-tells nothing.
    bob.editor.moveBlock(target, home, 0);
    await settled(10);
    expect(supersededNotice(alice.surface)).toBeNull();
    expect(supersededNotice(bob.surface)).toBeNull();
    expect(seen).toEqual([]);
    done(bob, alice);
  }, 30_000);

  test("4. reassertion: the loser clicks Move it anyway — exactly one fresh move, it wins, the notice is gone", async () => {
    const { relay, race } = await draftedRace(11, 22); // bob wins the race
    const { alice, bob, target, home } = race;
    alice.editor.moveBlock(target, home, 0);
    bob.editor.moveBlock(target, null, 0);
    await settled(14);
    expect(layout(alice.editor.ydoc).placement.get(target)!.actor).toBe("human:bob");
    const notice = supersededNotice(alice.surface)!;
    expect(notice).not.toBeNull();

    const historyBefore = alice.editor.history().length;
    notice.querySelector<HTMLButtonElement>("button")!.click(); // "Move it anyway"
    await settled(14);

    // Exactly one fresh move transaction, intent reassert-move, to the losing move's original placement.
    const fresh = alice.editor.history().slice(historyBefore);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.intent).toBe("reassert-move");
    expect(fresh[0]!.ops).toEqual([{ op: "move", block: target, newParent: home, index: 0 }]);

    // It wins through DM-4.7's ordinary resolution — causally now — on both peers.
    const onAlice = layout(alice.editor.ydoc).placement.get(target)!;
    const onBob = layout(bob.editor.ydoc).placement.get(target)!;
    expect(onAlice).toEqual(onBob);
    expect(onAlice.parent).toBe(home);
    expect(onAlice.actor).toBe("human:alice");

    // The notice is gone, and the winner's surface never fired one.
    expect(supersededNotice(alice.surface)).toBeNull();
    expect(supersededNotice(bob.surface)).toBeNull();
    done(bob, alice);
  }, 30_000);

  test("5. a move racing a delete: deletion wording, and no reassert action", async () => {
    const { relay, race } = await draftedRace(22, 11); // alice deletes (client 22), bob moves (client 11): the tombstone wins the register
    const { alice, bob, target, home } = race;
    bob.editor.moveBlock(target, home, 0);
    alice.editor.deleteBlock(target);
    await settled(14);

    const onBob = layout(bob.editor.ydoc).placement.get(target)!;
    expect(onBob.tombstoned).toBe(true); // the register kept the delete (DM-4.7)
    const notice = supersededNotice(bob.surface)!;
    expect(notice).not.toBeNull();
    expect(notice.querySelector(".nq-notice-word")?.textContent).toBe("Alice deleted this block while you moved it."); // DM-4.8 wording (DM-4.9)
    const buttons = Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).map(button => button.textContent);
    expect(buttons).toEqual(["Dismiss"]); // no reassertion into a tombstone
    expect(supersededNotice(alice.surface)).toBeNull(); // the deleter never moved; nothing of hers lost
    done(bob, alice);
  }, 30_000);
});
