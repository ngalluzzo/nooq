/**
 * Persistence (DM-14.6): a stored document is its header beside its
 * canonical state; a secured one verifies against its log, which is a set.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  canonicalJson,
  createActorKey,
  createSecuredDocument,
  makeBlock,
  newBlockId,
  toBase64,
  type Access,
  type Op,
  type Transaction,
} from "@nooq/core";
import {
  commitSigned,
  createCheckpoint,
  layout,
  loadDocument,
  newDocument,
  readState,
  storeDocument,
  verifyLog,
  verifyStoredDocument,
  type LogEntry,
} from "../src/index.ts";

let lamport = 0;
const tx = (ops: Op[], actorId = "human:owner"): Transaction => ({ id: newBlockId(), actor: { actorId, kind: "human" }, lamport: ++lamport, causality: {}, ops });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A secured document written by its owner and a writer; returns its log in admission order. */
async function securedHistory() {
  const owner = await createActorKey(), writer = await createActorKey(), relay = await createActorKey();
  const ownerParty = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = { owner: ownerParty, nonce, grants: [
    { actorId: "human:writer", key: toBase64(writer.publicBytes), kind: "human", role: "writer" },
    { actorId: "system:relay", key: toBase64(relay.publicBytes), kind: "system", role: "checkpointer" },
  ] };
  const doc = newDocument(docId);
  const log: LogEntry[] = [];
  const commit = async (ops: Op[], actorId = "human:owner") => {
    const sealed = await commitSigned(doc, tx(ops, actorId), actorId === "human:owner" ? owner : writer, actorId);
    log.push(sealed);
    return sealed;
  };
  const genesis = await commit([{ op: "setAccess", access }]);
  const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "", marks: [] } }, "human:owner");
  await commit([{ op: "insert", block, parent: null }]);
  for (const [i, ch] of [..."stored safely"].entries()) await commit([{ op: "textEdit", block: block.id, changes: i ? [{ retain: i }, { insert: ch }] : [{ insert: ch }] }], i % 2 ? "human:writer" : "human:owner");
  return { docId, doc, log, genesis, block, relay };
}

describe("stored documents (DM-14.6)", () => {
  test("store and load keep the header beside canonical state; converged peers store identical bytes", async () => {
    const { doc, docId, log } = await securedHistory();
    const stored = storeDocument(doc);
    expect(stored.docId).toBe(docId);
    const loaded = loadDocument(stored);
    expect(canonicalJson(readState(loaded))).toBe(canonicalJson(readState(doc)));
    const replayed = await verifyLog(docId, { envelopes: log });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(storeDocument(replayed.doc).state).toEqual(stored.state); // a peer that replayed stores the same bytes
  });
});

describe("verifyLog: the log is a set (DM-14.6)", () => {
  test("any order verifies to the same state; a union of overlapping histories does too", async () => {
    const { doc, docId, log } = await securedHistory();
    const expected = storeDocument(doc).state;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed);
      const shuffled = [...log].sort(() => rng() - 0.5);
      const result = await verifyLog(docId, { envelopes: shuffled });
      expect(result.ok).toBe(true);
      if (result.ok) expect(storeDocument(result.doc).state).toEqual(expected);
    }
    const union = [...log.slice(0, 9), ...log.slice(4)]; // two histories sharing envelopes 4..8
    const merged = await verifyLog(docId, { envelopes: union });
    expect(merged.ok && storeDocument(merged.doc).state).toEqual(expected);
  });

  test("a forged envelope fails; a missing one leaves the rest unadmissible", async () => {
    const { docId, log } = await securedHistory();
    const forged = { ...log[5]!, envelope: { ...log[5]!.envelope, sig: log[4]!.envelope.sig } };
    expect(await verifyLog(docId, { envelopes: [...log.slice(0, 5), forged, ...log.slice(6)] })).toMatchObject({ ok: false, code: "envelope-log-invalid" });
    const gap = await verifyLog(docId, { envelopes: [...log.slice(0, 5), ...log.slice(6)] });
    expect(gap).toMatchObject({ ok: false, code: "envelope-log-invalid" });
    if (!gap.ok) expect(gap.reason).toContain("never became admissible");
  });

  test("from a checkpoint, only the envelopes after it are needed", async () => {
    const { doc, docId, log, genesis, relay } = await securedHistory();
    const atCheckpoint = newDocument(docId);
    for (const entry of log.slice(0, 8)) Y.applyUpdate(atCheckpoint, entry.update);
    const { checkpoint, state } = await createCheckpoint(atCheckpoint, { actorId: "system:relay", key: relay }, null);
    const result = await verifyLog(docId, { checkpoint: { checkpoint, state, accessProof: genesis.envelope }, envelopes: log.slice(8) });
    expect(result.ok && storeDocument(result.doc).state).toEqual(storeDocument(doc).state);
    const unproven = await verifyLog(docId, { checkpoint: { checkpoint, state, accessProof: log[3]!.envelope }, envelopes: log.slice(8) });
    expect(unproven).toMatchObject({ ok: false, code: "checkpoint-invalid" });
  });

  test("a stored state must equal its log's replay: an unsigned extra is caught", async () => {
    const { doc, docId, log } = await securedHistory();
    expect((await verifyStoredDocument(storeDocument(doc), { envelopes: log })).ok).toBe(true);
    const tampered = loadDocument(storeDocument(doc));
    layout(tampered).access.set("shadow", { smuggled: true }); // written at rest, attested by no envelope
    expect(await verifyStoredDocument(storeDocument(tampered), { envelopes: log })).toMatchObject({ ok: false, code: "stored-state-mismatch" });
    expect(docId).toBe(storeDocument(tampered).docId);
  });
});
