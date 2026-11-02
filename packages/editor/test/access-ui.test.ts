/** The access popover (foundation P1): the header's Access button on secured documents, fed by a real editor and peer. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import {
  createActorKey,
  createSecuredDocument,
  newBlockId,
  toBase64,
  type Access,
  type Transaction,
} from "@nooq/core";
import { commitSigned, newDocument } from "@nooq/yjs";
import { NooqRelay, settled } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createDocumentHeader, type DocumentHeader } from "../src/header.ts";

/** Settle the wire, then let renders, admission and the async ink hash land. */
async function painted(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) { await settled(); await new Promise(resolve => requestAnimationFrame(resolve)); }
}
/** Poll until ready, one wire-settle per round; fails loudly when it never lands. */
async function until(ready: () => boolean, rounds = 16): Promise<void> {
  for (let i = 0; i < rounds && !ready(); i++) await painted();
  expect(ready()).toBe(true);
}

async function keySet() {
  const maya = await createActorKey();
  const alice = await createActorKey();
  const bob = await createActorKey();
  const ai = await createActorKey();
  const ownerParty = { actorId: "human:maya", key: toBase64(maya.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = {
    owner: ownerParty,
    nonce,
    grants: [
      { actorId: "human:alice", key: toBase64(alice.publicBytes), kind: "human", role: "writer" },
      { actorId: "human:bob", key: toBase64(bob.publicBytes), kind: "human", role: "writer" },
      { actorId: "ai:reference", key: toBase64(ai.publicBytes), kind: "ai", role: "suggester" },
    ],
  };
  return { maya, alice, ai, access, docId };
}

/** Genesis + grants: the owner's single access lineage, shipped once (the signed-editor pattern). */
async function openForBusiness(relay: NooqRelay, keys: Awaited<ReturnType<typeof keySet>>): Promise<void> {
  const ownerDoc = newDocument(keys.docId);
  const genesisTx: Transaction = {
    id: newBlockId(),
    actor: { actorId: "human:maya", kind: "human" },
    lamport: 1,
    causality: {},
    ops: [{ op: "setAccess", access: keys.access }],
  };
  const committed = await commitSigned(ownerDoc, genesisTx, keys.maya, "human:maya");
  const transport = relay.connect(keys.docId);
  transport.send(JSON.stringify({ v: 1, t: "update", doc: keys.docId, update: Buffer.from(committed.update).toString("base64"), envelope: committed.envelope }));
  await settled(6);
}

function signedEditor(relay: NooqRelay, keys: Awaited<ReturnType<typeof keySet>>, who: "maya" | "alice"): Editor {
  const actorId = who === "maya" ? "human:maya" : "human:alice";
  const key = who === "maya" ? keys.maya : keys.alice;
  return new Editor({
    docId: keys.docId,
    actor: { actorId, name: who === "maya" ? "Maya" : "Alice" },
    transport: relay.connect(keys.docId),
    key,
  });
}

function accessButtonOf(header: DocumentHeader): HTMLButtonElement | null {
  return header.element.querySelector<HTMLButtonElement>(".nq-header-side button");
}

describe("the header's access popover", () => {
  test("an open document shows no Access button — open documents have no access header", async () => {
    const editor = new Editor({ docId: `open-${crypto.randomUUID()}`, actor: { actorId: "human:solo" } });
    const header = createDocumentHeader(editor, { selfName: "Solo" });
    document.body.append(header.element);
    await painted();
    expect(accessButtonOf(header)).toBeNull(); // no button, and no empty shell of one
    editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "still open" });
    await painted();
    expect(accessButtonOf(header)).toBeNull(); // document changes never conjure access on an open document
    header.destroy();
    editor.close();
  });

  test("a secured document shows the Access button; the popover joins names, roles and verified from a real editor and peer", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const maya = signedEditor(relay, keys, "maya");
    const header = createDocumentHeader(maya, { selfName: "Maya" });
    document.body.append(header.element);
    // The peer writes first (the handshake race): she settles her handshake
    // and bootstraps genesis, then her paragraph arrives everywhere as an
    // admitted envelope — landing her in arrivedVerified, never a held state.
    const alice = signedEditor(relay, keys, "alice");
    await settled();
    const block = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "typed by the peer" });
    alice.setCursor({ block, offset: 3 });
    await until(() => maya.accessState() !== undefined);
    await until(() => maya.arrivedVerified().has("human:alice"));

    const button = accessButtonOf(header)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("Access"); // the glyph is aria-hidden; the word is the name
    expect(button.classList.contains("nq-btn-quiet")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // Click opens the design popover anchored to the button, holding the panel.
    button.click();
    const popover = document.body.querySelector<HTMLElement>(".nq-popover")!;
    expect(popover).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const rows = () => Array.from(popover.querySelectorAll<HTMLElement>(".nq-access-row"));

    // Self first: Maya, the owner, key-verified as writer, with the word you.
    await until(() => rows().some(row => row.classList.contains("nq-access-self")));
    const self = popover.querySelector<HTMLElement>(".nq-access-self")!;
    expect(self.getAttribute("data-nq-actor")).toBe("human:maya");
    expect(self.querySelector(".nq-actor-name")?.textContent).toBe("Maya");
    expect(self.querySelector(".nq-access-role")?.textContent).toBe("Writer"); // the owner is implicitly a writer
    expect(self.querySelector(".nq-access-you")?.textContent).toBe("you");

    // The peer's row: name joined from awareness, verified as arrived-here, never idle on arrival.
    await until(() => rows().some(row => row.getAttribute("data-nq-actor") === "human:alice"));
    const aliceRow = popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:alice"]')!;
    expect(aliceRow.querySelector(".nq-actor-name")?.textContent).toBe("Alice");
    expect(aliceRow.querySelector(".nq-access-role")?.textContent).toBe("Writer");
    expect(aliceRow.querySelector(".nq-access-verified")?.getAttribute("title")).toBe("Their edits arrived verified here");

    // A grant whose actor never arrived renders the bare actor id; the AI grant its kind and model-free word.
    const bobRow = popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:bob"]')!;
    expect(bobRow.querySelector(".nq-actor-name")?.textContent).toBe("human:bob");
    expect(bobRow.hasAttribute("data-verified")).toBe(false); // bob never wrote here
    const aiRow = popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="ai:reference"]')!;
    expect(aiRow.querySelector(".nq-access-role")?.textContent).toBe("Suggester");
    expect(aiRow.querySelector(".nq-actor-kind")?.textContent).toBe("AI");
    expect(popover.querySelector(".nq-access-note")?.textContent).toBe("Removing a writer takes effect per device at sync time (DM-13.6).");

    // The panel re-renders on an access change while open: the owner appends a grant.
    const priya = await createActorKey();
    maya.setAccess({ ...keys.access, grants: [...keys.access.grants, { actorId: "human:priya", key: toBase64(priya.publicBytes), kind: "human", role: "reader" }] });
    await until(() => popover.querySelector('.nq-access-row[data-nq-actor="human:priya"]') !== null);
    expect(popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:priya"] .nq-access-role')?.textContent).toBe("Reader");

    // Esc closes returning focus to the button (the popover's contract).
    await new Promise(resolve => requestAnimationFrame(resolve)); // the popover's focus move lands first
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise(resolve => queueMicrotask(resolve));
    expect(document.body.contains(popover)).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    header.destroy();
    alice.close();
    maya.close();
  }, 30_000);

  test("the button opens on Enter too, and toggles closed on a second activation", async () => {
    const relay = new NooqRelay();
    const keys = await keySet();
    await openForBusiness(relay, keys);
    const maya = signedEditor(relay, keys, "maya");
    const header = createDocumentHeader(maya, { selfName: "Maya" });
    document.body.append(header.element);
    await until(() => accessButtonOf(header) !== null);
    const button = accessButtonOf(header)!;

    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    button.click(); // a real Enter on a button fires click
    const popover = document.body.querySelector<HTMLElement>(".nq-popover")!;
    expect(popover).not.toBeNull();
    button.click(); // the same control closes what it opened
    expect(document.body.contains(popover)).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    header.destroy();
    maya.close();
  }, 30_000);
});
