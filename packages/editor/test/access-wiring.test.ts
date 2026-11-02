/** §2a access wiring: admission verdicts, my role, verified arrivals, honest notices. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  createActorKey,
  createSecuredDocument,
  makeBlock,
  newBlockId,
  toBase64,
  type Access,
  type Transaction,
} from "@nooq/core";
import { applyCaptured, commitSigned, newDocument, sealEnvelope } from "@nooq/yjs";
import { encodeMessage, NooqRelay, settled, WIRE_VERSION, type SyncTransport } from "@nooq/sync";
import { Editor } from "../src/controller.ts";
import { createSurface, type EditorSurface } from "../src/dom.ts";

/** A transport the test drives by hand: what the session sends is captured, never answered. */
function scriptedTransport(): { transport: SyncTransport; deliver(raw: string): void; sent: string[] } {
  let handler: ((raw: string) => void) | undefined;
  const sent: string[] = [];
  const transport: SyncTransport = {
    send: (raw) => { sent.push(raw); },
    onMessage: (onMessage) => { handler = onMessage; },
    close: () => { handler = undefined; },
  };
  return { transport, deliver: (raw) => handler?.(raw), sent };
}

/** An owner-only secured document with one reader grant, ready for genesis. */
async function securedDoc() {
  const owner = await createActorKey(), reader = await createActorKey();
  const party = { actorId: "human:owner", kind: "human" as const, key: toBase64(owner.publicBytes) };
  const { docId, nonce } = await createSecuredDocument(party);
  const access: Access = { owner: party, nonce, grants: [{ actorId: "human:reader", key: toBase64(reader.publicBytes), kind: "human", role: "reader" }] };
  return { owner, reader, party, docId, nonce, access };
}

/** Genesis + grants, shipped once to the relay (the owner's single access lineage). */
async function genesis(relay: NooqRelay, docId: string, access: Access, ownerKey: Awaited<ReturnType<typeof createActorKey>>): Promise<void> {
  const doc = newDocument(docId);
  const tx: Transaction = { id: newBlockId(), actor: { actorId: access.owner.actorId, kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access }] };
  const committed = await commitSigned(doc, tx, ownerKey, access.owner.actorId);
  const transport = relay.connect(docId);
  transport.onMessage(() => {});
  transport.send(JSON.stringify({ v: 1, t: "update", doc: docId, update: Buffer.from(committed.update).toString("base64"), envelope: committed.envelope }));
  await settled(6);
}

describe("onAdmission registry (§2a)", () => {
  test("delivers the session's verdict and reason to every listener; a throwing listener lands in the error channel", async () => {
    const { owner, docId, access } = await securedDoc();
    const wire = scriptedTransport();
    const editor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner, transport: wire.transport });
    await editor.initializeAccess(access);
    await settled();
    const a: Array<[string, string | undefined]> = [], b: Array<[string, string | undefined]> = [];
    const offA = editor.onAdmission((verdict, reason) => a.push([verdict, reason]));
    editor.onAdmission(() => { throw new Error("listener exploded"); });
    const offB = editor.onAdmission((verdict, reason) => b.push([verdict, reason]));
    const unsigned = encodeMessage({ v: WIRE_VERSION, t: "update", doc: docId, update: toBase64(Y.encodeStateAsUpdate(editor.ydoc)) });
    wire.deliver(unsigned);
    await settled();
    expect(a).toEqual([["deny", "unsigned update in an access-controlled document"]]);
    expect(b).toEqual([["deny", "unsigned update in an access-controlled document"]]);
    expect(editor.errors.some(error => error.phase === "observer" && String(error.cause).includes("listener exploded"))).toBe(true);
    offA(); offB();
    wire.deliver(unsigned);
    await settled();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    editor.close();
  });

  test("a hold verdict carries its reason; the envelope is never applied", async () => {
    const owner = await createActorKey();
    const party = { actorId: "human:owner", kind: "human" as const, key: toBase64(owner.publicBytes) };
    const { docId } = await createSecuredDocument(party);
    const wire = scriptedTransport();
    const editor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner, transport: wire.transport });
    await settled();
    const seen: Array<[string, string | undefined]> = [];
    editor.onAdmission((verdict, reason) => seen.push([verdict, reason]));
    // A stranger's validly sealed envelope before genesis: held, with the session's own reason.
    const strangerKey = await createActorKey();
    const scratch = newDocument(docId);
    const tx: Transaction = { id: newBlockId(), actor: { actorId: "human:stranger", kind: "human" }, lamport: 1, causality: {},
      ops: [{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1" }, "human:stranger"), parent: null }] };
    const captured = applyCaptured(scratch, tx, strangerKey, "human:stranger")!;
    const envelope = await sealEnvelope(scratch, tx, captured.update, strangerKey, "human:stranger");
    wire.deliver(encodeMessage({ v: WIRE_VERSION, t: "update", doc: docId, update: toBase64(captured.update), envelope }));
    await settled();
    expect(seen).toEqual([["hold", "awaiting genesis"]]);
    expect(editor.view.roots).toHaveLength(0); // held: never applied, pends in the session
    editor.close();
    scratch.destroy();
  });
});

describe("myRole and accessState (§2a)", () => {
  test("the owner is implicitly a writer, a granted reader sees reader, an ungranted key and an open document see undefined", async () => {
    const { owner, reader, docId, access } = await securedDoc();
    const ownerEditor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner });
    await ownerEditor.initializeAccess(access);
    expect(ownerEditor.myRole()).toBe("writer");
    expect(ownerEditor.accessState()?.owner.actorId).toBe("human:owner");
    expect(ownerEditor.accessState()?.grants).toHaveLength(1);
    const readerEditor = new Editor({ docId, actor: { actorId: "human:reader" }, key: reader });
    await readerEditor.ready;
    Y.applyUpdate(readerEditor.ydoc, Y.encodeStateAsUpdate(ownerEditor.ydoc));
    expect(readerEditor.myRole()).toBe("reader");
    expect(readerEditor.accessState()?.grants[0]?.role).toBe("reader");
    const stranger = new Editor({ docId, actor: { actorId: "human:stranger" }, key: await createActorKey() });
    await stranger.ready;
    Y.applyUpdate(stranger.ydoc, Y.encodeStateAsUpdate(ownerEditor.ydoc));
    expect(stranger.myRole()).toBeUndefined(); // secured, but this key is in no grant
    const open = new Editor({ docId: "open-access-doc", actor: { actorId: "human:owner" }, key: owner });
    expect(open.myRole()).toBeUndefined();
    expect(open.accessState()).toBeUndefined();
    ownerEditor.close(); readerEditor.close(); stranger.close(); open.close();
  });
});

describe("arrivedVerified (§2a)", () => {
  test("grows for the owner when a peer's envelope arrives through a real relay; the local writer's own never counts", async () => {
    const relay = new NooqRelay();
    const ownerKey = await createActorKey(), aliceKey = await createActorKey();
    const party = { actorId: "human:owner", kind: "human" as const, key: toBase64(ownerKey.publicBytes) };
    const { docId, nonce } = await createSecuredDocument(party);
    const access: Access = { owner: party, nonce, grants: [{ actorId: "human:alice", key: toBase64(aliceKey.publicBytes), kind: "human", role: "writer" }] };
    await genesis(relay, docId, access, ownerKey);
    const owner = new Editor({ docId, actor: { actorId: "human:owner", name: "owner" }, transport: relay.connect(docId), key: ownerKey });
    const alice = new Editor({ docId, actor: { actorId: "human:alice", name: "alice" }, transport: relay.connect(docId), key: aliceKey });
    await settled();
    const verdicts: string[] = [];
    owner.onAdmission(verdict => verdicts.push(verdict));
    const before = new Set(owner.arrivedVerified()); // the bootstrap log already verified the genesis signer
    const paragraph = alice.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "from alice" });
    await settled(10);
    expect(owner.view.blocks[paragraph]!.text!.s).toBe("from alice"); // it really arrived
    expect(owner.arrivedVerified().has("human:alice")).toBe(true);
    expect(alice.arrivedVerified().has("human:alice")).toBe(false); // her own envelope is origin "local"
    for (const id of before) expect(owner.arrivedVerified().has(id)).toBe(true); // earlier verified arrivals persist
    expect(verdicts).toContain("allow");
    owner.close();
    alice.close();
  }, 30_000);
});

describe("access notices (§2a)", () => {
  /** A genesis'd owner document with one paragraph, and its reader grant key. */
  async function docWithParagraph() {
    const { owner, reader, docId, access } = await securedDoc();
    const ownerEditor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner });
    await ownerEditor.initializeAccess(access);
    ownerEditor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "editable by few" });
    return { ownerEditor, reader, docId };
  }
  const typeInto = (surface: EditorSurface, text: string): void => {
    const area = surface.element.querySelector<HTMLTextAreaElement>("textarea");
    if (!area) throw new Error("no text host mounted");
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };

  test("a reader's denied edit surfaces the denial notice with the reason verbatim", async () => {
    const { ownerEditor, reader, docId } = await docWithParagraph();
    const editor = new Editor({ docId, actor: { actorId: "human:reader" }, key: reader });
    await editor.ready;
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(ownerEditor.ydoc));
    const surface = createSurface(editor);
    document.body.append(surface.element);
    await settled();
    typeInto(surface, "editable by few, says the reader");
    await settled();
    const notice = surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='denial']");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("permission-denied"); // the reason, verbatim
    expect(surface.element.querySelector(".nq-notice[data-kind='error']")).toBeNull(); // not a generic error
    notice!.querySelector<HTMLButtonElement>("button")!.click();
    expect(surface.element.querySelector(".nq-notice")).toBeNull();
    surface.destroy();
    editor.close();
    ownerEditor.close();
  });

  test("a retryable hold surfaces the hold notice", async () => {
    const { ownerEditor, docId } = await docWithParagraph();
    const editor = new Editor({ docId, actor: { actorId: "human:stranger" }, key: await createActorKey() }); // validly keyed, in no grant
    await editor.ready;
    Y.applyUpdate(editor.ydoc, Y.encodeStateAsUpdate(ownerEditor.ydoc));
    const surface = createSurface(editor);
    document.body.append(surface.element);
    await settled();
    typeInto(surface, "held, not denied");
    await settled();
    const notice = surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='hold']");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("grant-not-ready");
    expect(surface.element.querySelector(".nq-notice[data-kind='error']")).toBeNull();
    surface.destroy();
    editor.close();
    ownerEditor.close();
  });

  test("a session denial verdict shows the denial notice with the session's reason", async () => {
    const { owner, docId, access } = await securedDoc();
    const wire = scriptedTransport();
    const editor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner, transport: wire.transport });
    await editor.initializeAccess(access);
    const surface = createSurface(editor);
    document.body.append(surface.element);
    await settled();
    wire.deliver(encodeMessage({ v: WIRE_VERSION, t: "update", doc: docId, update: toBase64(Y.encodeStateAsUpdate(editor.ydoc)) }));
    await settled();
    const notice = surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='denial']");
    expect(notice?.textContent).toContain("unsigned update in an access-controlled document");
    surface.destroy();
    editor.close();
  });

  test("the local writer's remotely denied envelope (wire envelope-denied) shows the denial notice", async () => {
    const { owner, docId, access } = await securedDoc();
    const wire = scriptedTransport();
    const editor = new Editor({ docId, actor: { actorId: "human:owner" }, key: owner, transport: wire.transport });
    await editor.initializeAccess(access);
    const surface = createSurface(editor);
    document.body.append(surface.element);
    await settled();
    // Exactly what the relay answers a session whose envelope failed admission.
    wire.deliver(encodeMessage({ v: WIRE_VERSION, t: "error", doc: docId, code: "envelope-denied", message: "update failed verification or authorization" }));
    await settled();
    const notice = surface.element.querySelector<HTMLElement>(".nq-notice[data-kind='denial']");
    expect(notice?.textContent).toContain("update failed verification or authorization");
    surface.destroy();
    editor.close();
  });
});
