/**
 * Versions and rebase (DM-14.5, DM-16, proposals/0005).
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  canonicalJson,
  createActorKey,
  createSecuredDocument,
  makeBlock,
  newBlockId,
  rootDigest,
  toBase64,
  type Access,
  type Op,
  type Transaction,
} from "@nooq/core";
import { admitEnvelope, applyTransaction, commitSigned, newDocument, readState, rebase, stateAt, textAuthors, versionOf } from "../src/index.ts";

let lamport = 0;
const tx = (ops: Op[], actorId = "human:alice", kind: "human" | "ai" = "human"): Transaction =>
  ({ id: newBlockId(), actor: { actorId, kind }, lamport: ++lamport, causality: {}, ops });
const plain = (s: string) => ({ s, marks: s.split("").map(() => [] as string[]) });

/** A document with nesting, marks, fields, a tombstone and plenty of edit history. */
function busyDocument(docId = "lineage-doc") {
  const doc = newDocument(docId);
  const section = makeBlock({ type: "nooq.section/v1", fields: { title: "Intro" } }, "human:alice");
  const para = makeBlock({ type: "nooq.paragraph/v1", text: plain("") }, "human:alice");
  const gone = makeBlock({ type: "nooq.paragraph/v1", text: plain("deleted later") }, "human:alice");
  applyTransaction(doc, tx([{ op: "insert", block: section, parent: null }, { op: "insert", block: para, parent: section.id }, { op: "insert", block: gone, parent: section.id }]));
  for (let i = 0; i < 300; i++) {
    const length = readState(doc).blocks[para.id]!.text!.s.length;
    applyTransaction(doc, tx([{ op: "textEdit", block: para.id, changes: i % 3 === 2 ? [{ retain: length - 1 }, { delete: 1 }] : [{ retain: length }, { insert: "ab"[i % 2]! }] }]));
  }
  applyTransaction(doc, tx([{ op: "textEdit", block: para.id, changes: [{ retain: 0 }, { retain: 4, setMarks: ["bold"] }] }], "ai:helper", "ai"));
  applyTransaction(doc, tx([{ op: "setField", block: section.id, key: "tone", value: "warm" }]));
  applyTransaction(doc, tx([{ op: "delete", block: gone.id }]));
  return { doc, section, para, gone };
}

describe("versions (DM-14.5)", () => {
  test("a version rebuilds its past state exactly, attribution included, on any peer with the state", () => {
    const { doc, para } = busyDocument();
    const version = versionOf(doc);
    const then = { state: canonicalJson(readState(doc)), authors: textAuthors(doc, para.id) };
    applyTransaction(doc, tx([{ op: "textEdit", block: para.id, changes: [{ delete: 10 }, { insert: "rewritten " }] }], "ai:helper", "ai"));
    expect(canonicalJson(readState(doc))).not.toBe(then.state);

    const past = stateAt(doc, version);
    expect(canonicalJson(readState(past))).toBe(then.state);
    expect(textAuthors(past, para.id)).toEqual(then.authors);
    const peer = newDocument("lineage-doc");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(canonicalJson(readState(stateAt(peer, version)))).toBe(then.state);
    expect(version.length).toBeLessThan(Y.encodeStateAsUpdate(doc).length / 10);
  });
});

describe("rebase (DM-16)", () => {
  test("an open document rebases to the same visible state, without tombstones or history", async () => {
    const { doc, gone } = busyDocument();
    const before = canonicalJson(readState(doc));
    const { doc: lineage } = await rebase(doc, { docId: "lineage-doc-2", actor: { actorId: "human:alice", kind: "human" }, lamport: ++lamport });
    expect(await rootDigest(readState(lineage))).toBe(await rootDigest(readState(doc)));
    expect(readState(lineage).blocks[gone.id]).toBeUndefined(); // no tombstones
    expect(Y.encodeStateAsUpdate(lineage).length).toBeLessThan(Y.encodeStateAsUpdate(doc).length / 2);
    expect(canonicalJson(readState(doc))).toBe(before); // the archive is untouched
  });

  test("a secured document: the owner signs one genesis that pins its archive; peers admit it", async () => {
    const owner = await createActorKey(), writer = await createActorKey();
    const ownerParty = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
    const grants = [{ actorId: "human:writer", key: toBase64(writer.publicBytes), kind: "human" as const, role: "writer" as const }];
    const { docId, nonce } = await createSecuredDocument(ownerParty);
    const doc = newDocument(docId);
    await commitSigned(doc, tx([{ op: "setAccess", access: { owner: ownerParty, nonce, grants } }], "human:owner"), owner, "human:owner");
    const block = makeBlock({ type: "nooq.paragraph/v1", text: plain("kept") }, "human:owner");
    await commitSigned(doc, tx([{ op: "insert", block, parent: null }], "human:owner"), owner, "human:owner");
    await commitSigned(doc, tx([{ op: "textEdit", block: block.id, changes: [{ retain: 4 }, { insert: " safe" }] }], "human:writer"), writer, "human:writer");

    const next = await createSecuredDocument(ownerParty);
    const access: Access = { owner: ownerParty, nonce: next.nonce, grants, rebasedFrom: { docId, checkpoint: null } };
    const { doc: lineage, genesis } = await rebase(doc, { docId: next.docId, actor: { actorId: "human:owner", kind: "human" }, lamport: ++lamport, access, key: owner });
    const peer = newDocument(next.docId);
    expect((await admitEnvelope(peer, genesis!.envelope, genesis!.update)).verdict).toBe("allow");
    expect(await rootDigest(readState(peer))).toBe(await rootDigest(readState(doc)));
    expect(readState(peer).access!.rebasedFrom).toEqual({ docId, checkpoint: null });
    expect(canonicalJson(readState(peer))).toBe(canonicalJson(readState(lineage)));

    // The pin never changes: an access write that drops it is denied.
    const { rebasedFrom: _dropped, ...unpinned } = access;
    const rewrite = await commitSigned(lineage, tx([{ op: "setAccess", access: unpinned }], "human:owner"), owner, "human:owner");
    expect((await admitEnvelope(peer, rewrite.envelope, rewrite.update)).verdict).toBe("deny");
    expect(readState(peer).access!.rebasedFrom).toEqual({ docId, checkpoint: null });

    // Only the owner can rebase a secured document: only the owner signs a genesis.
    await expect(rebase(doc, { docId: next.docId, actor: { actorId: "human:writer", kind: "human" }, lamport: ++lamport, access, key: writer })).rejects.toThrow("only the owner");
  });
});
