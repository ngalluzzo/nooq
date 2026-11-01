/**
 * Checkpoints (DM-15, SW-3/SW-5, proposals/0005): a joiner verifies the
 * latest checkpoint and the envelopes after it, and reaches exactly the
 * state replaying from genesis reaches.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  checkpointId,
  createActorKey,
  createSecuredDocument,
  fromBase64,
  makeBlock,
  newBlockId,
  signCheckpoint,
  toBase64,
  type Access,
  type Op,
  type Transaction,
} from "@nooq/core";
import { admitEnvelope, commitSigned, layout, newDocument, readState, stateDigestOf } from "@nooq/yjs";
import { decodeMessage, encodeMessage, NooqRelay, settled, SyncSession, type SyncTransport, type WireMessage } from "../src/index.ts";
import { rt } from "./rt.ts";

let lamport = 0;
const tx = (ops: Op[], actorId: string, kind: "human" | "system" = "human"): Transaction =>
  ({ id: newBlockId(), actor: { actorId, kind }, lamport: ++lamport, causality: {}, ops });

async function world(options: { granted?: boolean; every?: number } = {}) {
  const owner = await createActorKey(), relayKey = await createActorKey();
  const ownerParty = { actorId: "human:owner", key: toBase64(owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = { owner: ownerParty, nonce, grants: options.granted === false ? [] : [
    { actorId: "system:relay", key: toBase64(relayKey.publicBytes), kind: "system", role: "checkpointer" },
  ] };
  const relay = new NooqRelay({ checkpointer: { actorId: "system:relay", key: relayKey, every: options.every ?? 5 } });
  const doc = newDocument(docId);
  const session = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:owner" });
  session.start();
  const commit = async (ops: Op[]) => {
    const sealed = await commitSigned(doc, tx(ops, "human:owner"), owner, "human:owner");
    session.sendUpdate(sealed.update, sealed.envelope);
  };
  await commit([{ op: "setAccess", access }]);
  const block = makeBlock({ type: "nooq.paragraph/v1", text: rt("") }, "human:owner");
  await commit([{ op: "insert", block, parent: null }]);
  const type = async (text: string) => {
    for (const ch of text) {
      const length = readState(doc).blocks[block.id]!.text!.s.length;
      await commit([{ op: "textEdit", block: block.id, changes: length ? [{ retain: length }, { insert: ch }] : [{ insert: ch }] }]);
    }
    await settled(20);
  };
  return { relay, docId, owner, relayKey, access, doc, session, block, type };
}

/** Join through a transport; collect errors and the envelopes it verified. */
async function join(docId: string, transport: SyncTransport) {
  const doc = newDocument(docId);
  const errors: string[] = [];
  const envelopes: string[] = [];
  const session = new SyncSession({ doc, transport, actor: "human:joiner", onError: (error) => errors.push(error.code), onEnvelope: (envelope) => envelopes.push(envelope.updateDigest) });
  session.start();
  await settled(20);
  return { doc, errors, envelopes, session };
}

/** The relay's genuine hello-reply to a fresh peer. */
async function genuineReply(relay: NooqRelay, docId: string): Promise<Extract<WireMessage, { t: "hello-reply" }>> {
  const transport = relay.connect(docId);
  let reply: WireMessage | null = null;
  transport.onMessage((raw) => { const message = decodeMessage(raw); if (message?.t === "hello-reply") reply = message; });
  transport.send(encodeMessage({ v: 1, t: "hello", doc: docId, backend: "yjs/1", sv: null, update: null }));
  await settled(20);
  return reply! as Extract<WireMessage, { t: "hello-reply" }>;
}

function scripted(reply: WireMessage): SyncTransport {
  let handler: ((raw: string) => void) | undefined;
  return {
    send: (raw) => { if (decodeMessage(raw)?.t === "hello") queueMicrotask(() => handler?.(encodeMessage(reply))); },
    onMessage: (h) => (handler = h),
    close: () => (handler = undefined),
  };
}

describe("checkpoints (DM-15)", () => {
  test("bootstrapping from a checkpoint equals replaying from genesis, on every peer (proposals/0005 gate)", async () => {
    const { relay, docId, type } = await world({ every: 5 }); // genesis + insert: 2 envelopes
    await type("abc"); // 5: the first checkpoint
    const first = relay.checkpointOf(docId)!;
    expect(first.previous).toBeNull();
    await type("defgh"); // 10: the second, chained to the first
    const second = relay.checkpointOf(docId)!;
    expect(second.previous).toBe(await checkpointId(first));
    await type("ij"); // 2 envelopes after it

    const joiner = await join(docId, relay.connect(docId));
    expect(joiner.errors).toEqual([]);
    expect(joiner.session.synced).toBe(true);
    const log = relay.envelopesOf(docId);
    expect(log).toHaveLength(12);
    expect(joiner.envelopes).toHaveLength(2); // covered envelopes are archive: they did not travel

    const replayed = newDocument(docId);
    for (const { envelope, update } of log) expect((await admitEnvelope(replayed, envelope, update)).verdict).toBe("allow");
    const encodings = [joiner.doc, replayed, relay.stored(docId)!].map((doc) => toBase64(Y.encodeStateAsUpdate(doc)));
    expect(new Set(encodings).size).toBe(1);
    expect(await stateDigestOf(joiner.doc)).toBe(await stateDigestOf(replayed));
    expect(readState(joiner.doc).blocks[Object.keys(readState(replayed).blocks)[0]!]!.text!.s).toBe("abcdefghij");
  });

  test("a relay not granted the role never checkpoints", async () => {
    const { relay, docId, type } = await world({ granted: false });
    await type("no grant, no checkpoint");
    expect(relay.checkpointOf(docId)).toBeUndefined();
    expect((await join(docId, relay.connect(docId))).errors).toEqual([]);
  });

  test("forged, ungranted, tampered and unproven checkpoints are refused", async () => {
    const { relay, docId, type, access } = await world();
    await type("attested");
    const reply = await genuineReply(relay, docId);
    expect(reply.checkpoint).toBeDefined();
    const point = reply.checkpoint!;
    const stranger = await createActorKey();
    const attacker = { actorId: "system:attacker", key: toBase64(stranger.publicBytes), kind: "system" as const };

    // A state with fabricated grants: the attacker grants itself the role and signs.
    const forgedDoc = newDocument(docId);
    Y.applyUpdate(forgedDoc, fromBase64(point.state));
    layout(forgedDoc).access.set("access", { ...access, grants: [...access.grants, { ...attacker, role: "checkpointer" }] });
    const forgedState = Y.encodeStateAsUpdate(forgedDoc);
    const { createCheckpoint } = await import("@nooq/yjs");
    const forged = await createCheckpoint(forgedDoc, { actorId: attacker.actorId, key: stranger }, null);

    const cases: Array<[string, WireMessage]> = [
      ["ungranted signer", { ...reply, checkpoint: { ...point, checkpoint: await signCheckpoint({ ...point.checkpoint, signer: "system:relay" }, stranger) } }],
      ["tampered state", { ...reply, checkpoint: { ...point, state: toBase64(forgedState) } }],
      ["fabricated grants", { ...reply, checkpoint: { ...point, checkpoint: forged.checkpoint, state: toBase64(forged.state) } }],
      ["no access proof", { ...reply, checkpoint: { ...point, accessProof: undefined as never } }],
      ["proof for another access", { ...reply, checkpoint: { ...point, accessProof: { ...point.accessProof, tx: { ...point.accessProof.tx, ops: [{ op: "setAccess", access: { ...access, grants: [] } }] } } } }],
    ];
    for (const [name, message] of cases) {
      const joiner = await join(docId, scripted(message));
      expect({ name, errors: joiner.errors }).toEqual({ name, errors: ["checkpoint-invalid"] });
      expect(readState(joiner.doc).access).toBeUndefined(); // nothing applied
    }
    // Control: the genuine reply verifies.
    expect((await join(docId, scripted(reply))).errors).toEqual([]);
  });

  test("a checkpointer signs checkpoints and nothing else (DM-13)", async () => {
    const { relay, docId, relayKey } = await world();
    await settled(20);
    const peer = newDocument(docId);
    for (const { envelope, update } of relay.envelopesOf(docId)) await admitEnvelope(peer, envelope, update);
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "system:relay");
    const write = await commitSigned(newDocument(docId), tx([{ op: "insert", block, parent: null }], "system:relay", "system"), relayKey, "system:relay");
    const admission = await admitEnvelope(peer, write.envelope, write.update);
    expect(admission.verdict).toBe("deny");
    expect(readState(peer).blocks[block.id]).toBeUndefined();
  });
});
